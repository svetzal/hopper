import { homedir } from "os";
import { join } from "path";
import type { ParsedArgs } from "../cli.ts";
import { claimNextItem, completeItem } from "../store.ts";
import type { Item } from "../store.ts";
import type { ClaudeGateway } from "../gateways/claude-gateway.ts";
import { createClaudeGateway } from "../gateways/claude-gateway.ts";
import type { FsGateway } from "../gateways/fs-gateway.ts";
import { createFsGateway } from "../gateways/fs-gateway.ts";
import type { GitGateway } from "../gateways/git-gateway.ts";
import { createGitGateway } from "../gateways/git-gateway.ts";
import type { ShellGateway } from "../gateways/shell-gateway.ts";
import { createShellGateway } from "../gateways/shell-gateway.ts";
import { shortId } from "../format.ts";
import {
  buildCommitMessage,
  buildTaskPrompt,
  resolveAuditPaths,
  resolveCompletionAction,
  resolveMergeAction,
  resolvePostClaudeAction,
  resolveWorkSetup,
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

export async function processItem(
  item: Item,
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

  const { auditDir, auditFile, resultFile } = resolveAuditPaths(
    item.id,
    hopperHome,
  );
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
      workBranch = await git.worktreeAdd(
        workSetup.repoDir,
        worktreePath,
        workSetup.branch,
        item.id,
      );
      log(`Work branch: ${workBranch}`);
      workDir = worktreePath;
    } else if (workSetup.type === "existing-dir") {
      workDir = workSetup.dir;
    }

    let exitCode: number;
    let result: string;

    if (item.command) {
      log(`Starting command...\nAudit log: ${auditFile}`);
      ({ exitCode, result } = await shell.runCommand(
        item.command,
        workDir ?? process.cwd(),
        auditFile,
      ));
    } else {
      const prompt = buildTaskPrompt(item);
      log(`Starting Claude session...\nAudit log: ${auditFile}`);
      ({ exitCode, result } = await claude.runSession(
        prompt,
        workDir ?? process.cwd(),
        auditFile,
      ));
    }

    // Commit any uncommitted changes Claude left in the worktree
    if (worktreePath) {
      const dirty = await git.isWorktreeDirty(worktreePath);
      const { shouldCommit } = resolvePostClaudeAction(true, dirty);
      if (shouldCommit) {
        const commitMsg = buildCommitMessage(item, result);
        log("Committing changes...");
        await git.commitAll(worktreePath, commitMsg);
        log("Committed.");
      }
    }

    // Remove worktree (branch is preserved for merge step)
    if (worktreePath && item.workingDir) {
      log("Removing worktree...");
      await git.worktreeRemove(item.workingDir, worktreePath);
      worktreePath = undefined;
    }

    // Merge work branch back to target (only on clean Claude exit)
    let mergeNote = "";
    const { shouldMerge } = resolveMergeAction(exitCode, workBranch, item);
    if (shouldMerge && workBranch && item.workingDir && item.branch) {
      log(`Merging ${workBranch} → ${item.branch}...`);
      const mergeResult = await git.mergeWorkBranch(
        item.workingDir,
        item.branch,
        workBranch,
      );
      log(mergeResult.message);
      mergeNote = `\n\n---\nMerge: ${mergeResult.message}`;
      if (mergeResult.success) {
        const pushResult = await git.push(item.workingDir, item.branch!);
        log(pushResult.message);
        if (!pushResult.success) {
          mergeNote += `\nPush: ${pushResult.message}`;
        }
      } else {
        log(`Action required: manually merge branch ${workBranch}.`);
      }
    }

    const { action, result: finalResult } = resolveCompletionAction(
      exitCode,
      result,
      mergeNote,
    );
    await fs.writeFile(resultFile, finalResult);

    const outputLabel = item.command ? "Command" : "Claude";
    log(`--- ${outputLabel} Output ---`);
    log(result);
    if (mergeNote) log(mergeNote.trim());
    log("---------------------");

    if (action === "complete") {
      log("Marking item complete...");
      const { completed, recurred } = await completeItem(item.claimToken!, agentName, finalResult);
      log(`Completed: ${completed.title}`);
      if (recurred) {
        log(`Re-queued: ${completed.title} (next run: ${new Date(recurred.scheduledAt!).toLocaleString()})`);
      }
    } else {
      const sessionLabel = item.command ? "Command" : "Claude session";
      log(`${sessionLabel} failed for: ${item.title} (${item.id})`);
      if (workBranch) log(`Work branch ${workBranch} preserved for review.`);
      log(`Use 'hopper requeue ${item.id} --reason "..."' to retry.`);
    }
  } finally {
    // Belt-and-suspenders: clean up worktree if something threw mid-flight
    if (worktreePath && item.workingDir) {
      await git.worktreeRemove(item.workingDir, worktreePath);
    }
  }
}

export async function workerCommand(
  parsed: ParsedArgs,
  deps?: WorkerDeps,
): Promise<void> {
  const git = deps?.git ?? createGitGateway();
  const claude = deps?.claude ?? createClaudeGateway();
  const fs = deps?.fs ?? createFsGateway();
  const shell = deps?.shell ?? createShellGateway();

  const agentName =
    typeof parsed.flags.agent === "string" ? parsed.flags.agent : "claude-worker";
  const pollInterval =
    typeof parsed.flags.interval === "string"
      ? parseInt(parsed.flags.interval, 10)
      : 60;
  const runOnce = parsed.flags.once === true;
  const concurrency =
    typeof parsed.flags.concurrency === "string"
      ? parseInt(parsed.flags.concurrency, 10)
      : 1;

  const hopperHome = join(homedir(), ".hopper");

  let running = true;
  const activeTasks = new Map<string, Promise<void>>();
  let cancelSleep: (() => void) | undefined;

  const shutdown = () => {
    if (!running) return;
    running = false;
    cancelSleep?.();
    if (activeTasks.size > 0) {
      console.log(`\nShutting down. Waiting for ${activeTasks.size} active task(s) to finish...`);
    } else {
      console.log("\nShutting down.");
    }
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  console.log(
    `Hopper worker starting (agent: ${agentName}, poll: ${pollInterval}s, concurrency: ${concurrency})`,
  );

  while (running) {
    // Wait for at least one free slot if all slots are occupied
    if (activeTasks.size >= concurrency) {
      await Promise.race(activeTasks.values());
      // Clean up finished tasks
      for (const [id, p] of activeTasks) {
        const settled = await Promise.race([
          p.then(() => true),
          Promise.resolve(false),
        ]);
        if (settled) activeTasks.delete(id);
      }
      continue;
    }

    const freeSlots = concurrency - activeTasks.size;

    if (freeSlots > 0 && activeTasks.size === 0) {
      console.log("\nChecking for work...");
    }

    let claimedAny = false;
    for (let i = 0; i < freeSlots; i++) {
      const item = await claimNextItem(agentName);
      if (!item) break;

      claimedAny = true;
      const task = processItem(item, agentName, hopperHome, { git, claude, fs, shell }, concurrency)
        .catch((err) => {
          console.error(`Error processing item ${shortId(item.id)}: ${err}`);
        })
        .finally(() => activeTasks.delete(item.id));
      activeTasks.set(item.id, task);
    }

    if (activeTasks.size === 0 && !claimedAny) {
      // No work available and nothing running
      if (runOnce) {
        console.log("No work available.");
        return;
      }
      console.log(`No work available. Waiting ${pollInterval}s...`);
      await new Promise<void>((r) => {
        const timer = setTimeout(r, pollInterval * 1000);
        cancelSleep = () => { clearTimeout(timer); r(); };
      });
      cancelSleep = undefined;
      continue;
    }

    if (runOnce) {
      // --once with concurrency: wait for all active tasks to finish, then exit
      if (activeTasks.size > 0) {
        await Promise.allSettled(activeTasks.values());
      }
      return;
    }
  }

  // Graceful shutdown: wait for active tasks with timeout
  if (activeTasks.size > 0) {
    const SHUTDOWN_TIMEOUT = 60_000;
    const timeout = new Promise<void>((resolve) =>
      setTimeout(() => {
        console.log("Warning: shutdown timeout reached (60s). Some tasks may not have finished.");
        resolve();
      }, SHUTDOWN_TIMEOUT),
    );
    await Promise.race([
      Promise.allSettled(activeTasks.values()),
      timeout,
    ]);
  }
}
