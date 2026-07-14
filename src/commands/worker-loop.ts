import { homedir } from "node:os";
import { join } from "node:path";
import type { ParsedArgs } from "../cli.ts";
import { fail } from "../command-runner.ts";
import { toErrorMessage } from "../error-utils.ts";
import { shortId } from "../format.ts";
import type { AgentRunner } from "../gateways/agent-runner.ts";
import type { FsGateway } from "../gateways/fs-gateway.ts";
import { createFsGateway } from "../gateways/fs-gateway.ts";
import type { GitGateway } from "../gateways/git-gateway.ts";
import { createGitGateway } from "../gateways/git-gateway.ts";
import type { ProfilesGateway } from "../gateways/profiles-gateway.ts";
import { createProfilesGateway } from "../gateways/profiles-gateway.ts";
import { createRoutingRunner } from "../gateways/routing-runner.ts";
import type { ShellGateway } from "../gateways/shell-gateway.ts";
import { createShellGateway } from "../gateways/shell-gateway.ts";
import {
  buildInvestigationShimMap,
  parseDisallowedTools,
} from "../gateways/worker-shim-content.ts";
import { createWorkerShimGateway } from "../gateways/worker-shim-gateway.ts";
import type { ClaimedItem } from "../store.ts";
import { claimNextItem, findItem } from "../store.ts";
import { EXECUTE_DISALLOWED_TOOLS, INVESTIGATION_DISALLOWED_TOOLS } from "../task-type-workflow.ts";
import {
  resolveLoopAction,
  resolvePostClaimLoopAction,
  resolveShutdownAction,
  resolveWorkerConfig,
  type WorkerConfig,
} from "../worker-workflow.ts";
import { type ProcessItemArgs, processItem, type WorkerDeps } from "./worker-generic.ts";
import { safeRequeue } from "./worker-orchestration.ts";

export interface WorkerLoopDeps {
  claimNext: (agentName: string) => Promise<ClaimedItem | null | undefined>;
  processItem: (args: ProcessItemArgs) => Promise<void>;
  sleep: (ms: number) => Promise<{ cancelled: boolean }>;
  log: (message: string) => void;
  onSignal: (signal: "SIGINT" | "SIGTERM", handler: () => void) => void;
  /**
   * Last-resort safety net: re-read the item's status and, if it is still
   * `in_progress`, requeue it with the given reason. Any error is swallowed
   * and logged — this must never crash the worker loop.
   */
  requeueIfStillClaimed: (itemId: string, reason: string, agentName: string) => Promise<void>;
}

export function createCancellableSleep(): {
  sleep: (ms: number) => Promise<{ cancelled: boolean }>;
  cancel: () => void;
} {
  let cancelFn: (() => void) | undefined;

  const sleep = (ms: number): Promise<{ cancelled: boolean }> =>
    new Promise<{ cancelled: boolean }>((resolve) => {
      const timer = setTimeout(() => resolve({ cancelled: false }), ms);
      cancelFn = () => {
        clearTimeout(timer);
        resolve({ cancelled: true });
      };
    });

  const cancel = () => {
    cancelFn?.();
    cancelFn = undefined;
  };

  return { sleep, cancel };
}

export async function runWorkerLoop(
  config: WorkerConfig,
  hopperHome: string,
  gatewayDeps: {
    git: GitGateway;
    claude: AgentRunner;
    fs: FsGateway;
    shell: ShellGateway;
    profiles: ProfilesGateway;
  },
  loopDeps: WorkerLoopDeps,
): Promise<void> {
  const { agentName, pollInterval, runOnce, concurrency } = config;
  const { claimNext, processItem: doProcessItem, sleep, log, onSignal } = loopDeps;

  let running = true;
  const activeTasks = new Map<string, Promise<void>>();

  const shutdown = () => {
    const action = resolveShutdownAction(!running, activeTasks.size);
    if (action.type === "already-shutting-down") return;
    running = false;
    log(action.message);
  };

  onSignal("SIGINT", shutdown);
  onSignal("SIGTERM", shutdown);

  log(
    `Hopper worker starting (agent: ${agentName}, poll: ${pollInterval}s, concurrency: ${concurrency})`,
  );

  while (running) {
    const loopAction = resolveLoopAction(activeTasks.size, concurrency, running);

    if (loopAction.type === "wait-for-slot") {
      await Promise.race(activeTasks.values());
      for (const [id, p] of activeTasks) {
        const settled = await Promise.race([p.then(() => true), Promise.resolve(false)]);
        if (settled) activeTasks.delete(id);
      }
      continue;
    }

    if (loopAction.type === "claim") {
      if (loopAction.shouldLog) {
        log("\nChecking for work...");
      }

      let claimedAny = false;
      for (let i = 0; i < loopAction.freeSlots; i++) {
        const item = await claimNext(agentName);
        if (!item) break;
        claimedAny = true;
        const task = doProcessItem({ item, agentName, hopperHome, deps: gatewayDeps, concurrency })
          .catch(async (e) => {
            log(`Error processing item ${shortId(item.id)}: ${toErrorMessage(e)}`);
            await loopDeps.requeueIfStillClaimed(
              item.id,
              `Worker crashed before completion: ${toErrorMessage(e)}`,
              agentName,
            );
          })
          .finally(() => activeTasks.delete(item.id));
        activeTasks.set(item.id, task);
      }

      const postAction = resolvePostClaimLoopAction(
        activeTasks.size,
        claimedAny,
        runOnce,
        pollInterval,
      );

      switch (postAction.type) {
        case "exit-no-work":
          log(postAction.message);
          return;
        case "sleep":
          log(postAction.message);
          await sleep(pollInterval * 1000);
          continue;
        case "wait-and-exit":
          if (activeTasks.size > 0) {
            await Promise.allSettled(activeTasks.values());
          }
          return;
        case "continue":
          break;
      }
    }
  }

  // Graceful shutdown: wait for active tasks with timeout
  if (activeTasks.size > 0) {
    const shutdownTimeoutMs = config.shutdownTimeoutMs ?? 60_000;
    const timeout = new Promise<void>((resolve) =>
      setTimeout(() => {
        log("Warning: shutdown timeout reached (60s). Some tasks may not have finished.");
        resolve();
      }, shutdownTimeoutMs),
    );
    await Promise.race([Promise.allSettled(activeTasks.values()), timeout]);
  }
}

export async function workerCommand(parsed: ParsedArgs, deps?: WorkerDeps): Promise<void> {
  // The legacy `--runner` flag was removed in 3.0.0. Per-item profiles now
  // determine which runner handles each session; the worker is runner-agnostic
  // by default. Surface a friendly error if anyone still passes the flag.
  if ("runner" in parsed.flags) {
    fail(
      "--runner was removed in hopper 3.0.0; runner selection is now per-item via profiles. " +
        "Use `hopper add --profile <name>` to queue items against a specific profile.",
    );
  }

  const hopperHome = join(homedir(), ".hopper");
  const git = deps?.git ?? createGitGateway();
  const profiles = deps?.profiles ?? createProfilesGateway(hopperHome);
  // Bootstrap on first run so a fresh ~/.hopper/ gets config.json + the four
  // shipped profile templates (anthropic / openai / openrouter / ollama).
  await profiles.bootstrap();

  const log = deps?.log ?? ((msg: string) => console.log(msg));

  // Regenerate PATH shims idempotently so the investigation sandbox is always
  // up to date with the current INVESTIGATION_DISALLOWED_TOOLS list.
  const workerShim = deps?.workerShim ?? createWorkerShimGateway();
  const shimDir = join(hopperHome, "worker-shims");
  const denyMap = buildInvestigationShimMap(INVESTIGATION_DISALLOWED_TOOLS);
  const shimResult = await workerShim.synchronize(shimDir, denyMap);
  const gitShimResult = await workerShim.synchronize(
    join(hopperHome, "git-ownership-shims"),
    parseDisallowedTools(EXECUTE_DISALLOWED_TOOLS),
  );
  if (shimResult.status === "skipped-windows" || gitShimResult.status === "skipped-windows") {
    log(
      "Warning: PATH shims are POSIX-only; investigation and git-ownership enforcement on Windows rely on runner denylist support.",
    );
  }

  const claude = deps?.claude ?? createRoutingRunner();
  const fs = deps?.fs ?? createFsGateway();
  const shell = deps?.shell ?? createShellGateway();

  const config = resolveWorkerConfig(parsed.flags);
  const { sleep, cancel } = createCancellableSleep();

  const loopDeps: WorkerLoopDeps = {
    claimNext: deps?.claimNext ?? claimNextItem,
    processItem,
    sleep,
    log,
    onSignal: (signal, handler) =>
      process.on(signal, () => {
        cancel();
        handler();
      }),
    requeueIfStillClaimed: async (itemId, reason, agentName) => {
      try {
        const itemResult = await findItem(itemId);
        if (itemResult.ok && itemResult.value.status === "in_progress") {
          await safeRequeue(itemId, reason, agentName, (msg) =>
            log(`Warning: last-resort requeue for ${shortId(itemId)} failed: ${msg}`),
          );
        }
      } catch (e) {
        log(`Warning: last-resort requeue for ${shortId(itemId)} failed: ${toErrorMessage(e)}`);
      }
    },
  };

  await runWorkerLoop(config, hopperHome, { git, claude, fs, shell, profiles }, loopDeps);
}
