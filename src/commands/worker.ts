import { homedir } from "node:os";
import { join } from "node:path";
import type { ParsedArgs } from "../cli.ts";
import { shortId } from "../format.ts";
import type { ClaudeGateway } from "../gateways/claude-gateway.ts";
import { createClaudeGateway } from "../gateways/claude-gateway.ts";
import type { FsGateway } from "../gateways/fs-gateway.ts";
import { createFsGateway } from "../gateways/fs-gateway.ts";
import type { GitGateway, MergeOutcome } from "../gateways/git-gateway.ts";
import { createGitGateway } from "../gateways/git-gateway.ts";
import type { ShellGateway } from "../gateways/shell-gateway.ts";
import { createShellGateway } from "../gateways/shell-gateway.ts";
import {
  buildWorkBranchName,
  resolveBranchSetup,
  resolveFfResult,
  resolveMergeCommitResult,
  resolveMergeStep,
} from "../git-workflow.ts";
import type { ClaimedItem, Item } from "../store.ts";
import { claimNextItem, completeItem } from "../store.ts";
import {
  buildCommitMessage,
  buildTaskPrompt,
  resolveAuditPaths,
  resolveCompletionAction,
  resolveLoopAction,
  resolveMergeAction,
  resolvePostClaimLoopAction,
  resolvePostClaudeAction,
  resolveShutdownAction,
  resolveWorkerConfig,
  resolveWorkSetup,
  type WorkerConfig,
} from "../worker-workflow.ts";

export interface WorkerDeps {
  git?: GitGateway;
  claude?: ClaudeGateway;
  fs?: FsGateway;
  shell?: ShellGateway;
}

type LogFn = (message: string) => void;

function createLogger(itemId: string, concurrency: number): LogFn {
  if (concurrency > 1) {
    const prefix = `[${shortId(itemId)}]`;
    return (message: string) => console.log(`${prefix} ${message}`);
  }
  return (message: string) => console.log(message);
}

async function orchestrateWorktreeSetup(
  git: GitGateway,
  repoDir: string,
  branch: string,
  worktreePath: string,
  itemId: string,
): Promise<string> {
  const localExists = await git.branchExists(repoDir, branch);
  const remoteExists = await git.remoteBranchExists(repoDir, branch);
  const branchAction = resolveBranchSetup(branch, { localExists, remoteExists });

  switch (branchAction.type) {
    case "track-remote":
      await git.createTrackingBranch(repoDir, branch, branchAction.remoteRef);
      break;
    case "create-from-head":
      await git.createBranch(repoDir, branch);
      break;
    case "use-existing":
      break;
  }

  const workBranch = buildWorkBranchName(itemId);
  await git.createWorktree(repoDir, worktreePath, workBranch, branch);
  return workBranch;
}

async function orchestrateMerge(
  git: GitGateway,
  repoDir: string,
  targetBranch: string,
  workBranch: string,
): Promise<MergeOutcome> {
  const currentBranch = await git.getCurrentBranch(repoDir);
  const mergeCtx = { workBranch, targetBranch };
  const initialStep = resolveMergeStep(currentBranch, targetBranch);

  let restoreBranch: string | undefined;
  if (initialStep.type === "checkout-and-attempt-ff") {
    restoreBranch = initialStep.originalBranch;
    await git.checkout(repoDir, targetBranch);
  }

  try {
    const ffExit = await git.mergeFastForward(repoDir, workBranch);
    const ffResult = resolveFfResult(ffExit, mergeCtx);

    if (ffResult.type === "ff-succeeded") {
      await git.deleteBranch(repoDir, workBranch);
      return ffResult.outcome;
    }

    const mergeExit = await git.mergeCommit(repoDir, workBranch);
    const mcResult = resolveMergeCommitResult(mergeExit, mergeCtx);

    if (mcResult.type === "merge-commit-succeeded") {
      await git.deleteBranch(repoDir, workBranch);
      return mcResult.outcome;
    }

    await git.mergeAbort(repoDir);
    if (mcResult.type !== "conflict-abort") {
      throw new Error(`Unexpected merge step type: ${mcResult.type}`);
    }
    return mcResult.outcome;
  } finally {
    if (restoreBranch) {
      await git.checkout(repoDir, restoreBranch);
    }
  }
}

async function handleCompletion(
  item: ClaimedItem,
  agentName: string,
  exitCode: number,
  result: string,
  mergeNote: string,
  workBranch: string | undefined,
  fs: FsGateway,
  resultFile: string,
  log: LogFn,
): Promise<void> {
  const { action, result: finalResult } = resolveCompletionAction(exitCode, result, mergeNote);
  await fs.writeFile(resultFile, finalResult);

  const outputLabel = item.command ? "Command" : "Claude";
  log(`--- ${outputLabel} Output ---`);
  log(result);
  if (mergeNote) log(mergeNote.trim());
  log("---------------------");

  if (action === "complete") {
    log("Marking item complete...");
    const { completed, recurred } = await completeItem(item.claimToken, agentName, finalResult);
    log(`Completed: ${completed.title}`);
    if (recurred) {
      log(
        `Re-queued: ${completed.title} (next run: ${recurred.scheduledAt ? new Date(recurred.scheduledAt).toLocaleString() : "unknown"})`,
      );
    }
  } else {
    const sessionLabel = item.command ? "Command" : "Claude session";
    log(`${sessionLabel} failed for: ${item.title} (${item.id})`);
    if (workBranch) log(`Work branch ${workBranch} preserved for review.`);
    log(`Use 'hopper requeue ${item.id} --reason "..."' to retry.`);
  }
}

async function mergeAndPush(
  git: GitGateway,
  item: Item,
  workBranch: string,
  log: LogFn,
): Promise<string> {
  const targetBranch = item.branch as string;
  const repoDir = item.workingDir as string;
  log(`Merging ${workBranch} → ${targetBranch}...`);
  const mergeResult = await orchestrateMerge(git, repoDir, targetBranch, workBranch);
  log(mergeResult.message);
  let mergeNote = `\n\n---\nMerge: ${mergeResult.message}`;
  if (mergeResult.success) {
    const pushResult = await git.push(repoDir, targetBranch);
    log(pushResult.message);
    if (!pushResult.success) {
      mergeNote += `\nPush: ${pushResult.message}`;
    }
    const tagResult = await git.pushTags(repoDir);
    if (tagResult.success) {
      log(tagResult.message);
    } else {
      log(`Warning: ${tagResult.message}`);
      mergeNote += `\nTags: ${tagResult.message}`;
    }
  } else {
    log(`Action required: manually merge branch ${workBranch}.`);
  }
  return mergeNote;
}

async function teardownWorktree(
  git: GitGateway,
  repoDir: string,
  worktreePath: string,
  log: LogFn,
): Promise<void> {
  log("Removing worktree...");
  await git.worktreeRemove(repoDir, worktreePath);
}

async function commitWorktreeChanges(
  git: GitGateway,
  worktreePath: string,
  item: Item,
  result: string,
  log: LogFn,
): Promise<void> {
  const dirty = await git.isWorktreeDirty(worktreePath);
  const { shouldCommit } = resolvePostClaudeAction(true, dirty);
  if (shouldCommit) {
    const commitMsg = buildCommitMessage(item, result);
    log("Committing changes...");
    await git.commitAll(worktreePath, commitMsg);
    log("Committed.");
  }
}

async function executeWork(
  item: Item,
  workDir: string | undefined,
  auditFile: string,
  deps: { claude: ClaudeGateway; shell: ShellGateway },
  log: LogFn,
): Promise<{ exitCode: number; result: string }> {
  const { claude, shell } = deps;
  if (item.command) {
    log(`Starting command...\nAudit log: ${auditFile}`);
    return shell.runCommand(item.command, workDir ?? process.cwd(), auditFile);
  }
  const prompt = buildTaskPrompt(item);
  log(`Starting Claude session...\nAudit log: ${auditFile}`);
  return claude.runSession(prompt, workDir ?? process.cwd(), auditFile);
}

export async function processItem(
  item: ClaimedItem,
  agentName: string,
  hopperHome: string,
  deps: { git: GitGateway; claude: ClaudeGateway; fs: FsGateway; shell: ShellGateway },
  concurrency: number = 1,
): Promise<void> {
  const { git, claude, fs, shell } = deps;
  const log = createLogger(item.id, concurrency);

  log(`Claimed: ${item.title}`);
  log(`Token:   ${item.claimToken}`);
  log(`ID:      ${item.id}`);
  if (item.workingDir) log(`Dir:     ${item.workingDir}`);
  if (item.branch) log(`Branch:  ${item.branch}`);
  if (item.command) log(`Command: ${item.command}`);

  const { auditDir, auditFile, resultFile } = resolveAuditPaths(item.id, hopperHome);
  await fs.ensureDir(auditDir);

  const workSetup = resolveWorkSetup(item, hopperHome);

  let worktreePath: string | undefined;
  let workBranch: string | undefined;
  let workDir: string | undefined;

  try {
    if (workSetup.type === "worktree") {
      worktreePath = workSetup.worktreePath;
      await fs.ensureDir(join(hopperHome, "worktrees"));
      log(`Setting up worktree at ${worktreePath}...`);
      workBranch = await orchestrateWorktreeSetup(
        git,
        workSetup.repoDir,
        workSetup.branch,
        worktreePath,
        item.id,
      );
      log(`Work branch: ${workBranch}`);
      workDir = worktreePath;
    } else if (workSetup.type === "existing-dir") {
      workDir = workSetup.dir;
    }

    const { exitCode, result } = await executeWork(
      item,
      workDir,
      auditFile,
      { claude, shell },
      log,
    );

    if (worktreePath) {
      await commitWorktreeChanges(git, worktreePath, item, result, log);
    }

    if (worktreePath && item.workingDir) {
      await teardownWorktree(git, item.workingDir, worktreePath, log);
      worktreePath = undefined;
    }

    const { shouldMerge } = resolveMergeAction(exitCode, workBranch, item);
    const mergeNote =
      shouldMerge && workBranch && item.workingDir && item.branch
        ? await mergeAndPush(git, item, workBranch, log)
        : "";

    await handleCompletion(
      item,
      agentName,
      exitCode,
      result,
      mergeNote,
      workBranch,
      fs,
      resultFile,
      log,
    );
  } finally {
    // Belt-and-suspenders: clean up worktree if something threw mid-flight
    if (worktreePath && item.workingDir) {
      await git.worktreeRemove(item.workingDir, worktreePath);
    }
  }
}

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
          .catch((err) => {
            console.error(`Error processing item ${shortId(item.id)}: ${err}`);
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

  const loopDeps: WorkerLoopDeps = {
    claimNext: claimNextItem,
    processItem,
    sleep,
    log: (msg) => console.log(msg),
    onSignal: (signal, handler) =>
      process.on(signal, () => {
        cancel();
        handler();
      }),
  };

  await runWorkerLoop(config, hopperHome, { git, claude, fs, shell }, loopDeps);
}
