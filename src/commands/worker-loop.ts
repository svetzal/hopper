import { homedir } from "node:os";
import { join } from "node:path";
import type { ParsedArgs } from "../cli.ts";
import { toErrorMessage } from "../error-utils.ts";
import { shortId } from "../format.ts";
import type { ClaudeGateway } from "../gateways/claude-gateway.ts";
import { createClaudeGateway } from "../gateways/claude-gateway.ts";
import type { FsGateway } from "../gateways/fs-gateway.ts";
import { createFsGateway } from "../gateways/fs-gateway.ts";
import type { GitGateway } from "../gateways/git-gateway.ts";
import { createGitGateway } from "../gateways/git-gateway.ts";
import type { ShellGateway } from "../gateways/shell-gateway.ts";
import { createShellGateway } from "../gateways/shell-gateway.ts";
import type { ClaimedItem } from "../store.ts";
import { claimNextItem, findItem, requeueItem } from "../store.ts";
import {
  resolveLoopAction,
  resolvePostClaimLoopAction,
  resolveShutdownAction,
  resolveWorkerConfig,
  type WorkerConfig,
} from "../worker-workflow.ts";
import { processItem, type WorkerDeps } from "./worker.ts";

export interface WorkerLoopDeps {
  claimNext: (agentName: string) => Promise<ClaimedItem | null | undefined>;
  processItem: (
    item: ClaimedItem,
    agentName: string,
    hopperHome: string,
    deps: { git: GitGateway; claude: ClaudeGateway; fs: FsGateway; shell: ShellGateway },
    concurrency: number,
  ) => Promise<void>;
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

function createCancellableSleep(): {
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
  gatewayDeps: { git: GitGateway; claude: ClaudeGateway; fs: FsGateway; shell: ShellGateway },
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
        const task = doProcessItem(item, agentName, hopperHome, gatewayDeps, concurrency)
          .catch(async (err) => {
            log(`Error processing item ${shortId(item.id)}: ${err}`);
            try {
              await loopDeps.requeueIfStillClaimed(
                item.id,
                `Worker crashed before completion: ${toErrorMessage(err)}`,
                agentName,
              );
            } catch (requeueErr) {
              log(
                `Warning: last-resort requeue for ${shortId(item.id)} failed: ${toErrorMessage(requeueErr)}`,
              );
            }
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
    const SHUTDOWN_TIMEOUT = 60_000;
    const timeout = new Promise<void>((resolve) =>
      setTimeout(() => {
        log("Warning: shutdown timeout reached (60s). Some tasks may not have finished.");
        resolve();
      }, SHUTDOWN_TIMEOUT),
    );
    await Promise.race([Promise.allSettled(activeTasks.values()), timeout]);
  }
}

export async function workerCommand(parsed: ParsedArgs, deps?: WorkerDeps): Promise<void> {
  const git = deps?.git ?? createGitGateway();
  const claude = deps?.claude ?? createClaudeGateway();
  const fs = deps?.fs ?? createFsGateway();
  const shell = deps?.shell ?? createShellGateway();

  const config = resolveWorkerConfig(parsed.flags);
  const hopperHome = join(homedir(), ".hopper");
  const { sleep, cancel } = createCancellableSleep();

  const log = (msg: string) => console.log(msg);

  const loopDeps: WorkerLoopDeps = {
    claimNext: claimNextItem,
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
        const item = await findItem(itemId);
        if (item.status === "in_progress") {
          await requeueItem(itemId, reason, agentName);
        }
      } catch (err) {
        log(`Warning: last-resort requeue for ${shortId(itemId)} failed: ${err}`);
      }
    },
  };

  await runWorkerLoop(config, hopperHome, { git, claude, fs, shell }, loopDeps);
}
