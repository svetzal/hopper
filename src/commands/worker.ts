import { join } from "node:path";
import type { ClaudeGateway } from "../gateways/claude-gateway.ts";
import type { FsGateway } from "../gateways/fs-gateway.ts";
import type { GitGateway } from "../gateways/git-gateway.ts";
import type { ShellGateway } from "../gateways/shell-gateway.ts";
import type { ClaimedItem, Item } from "../store.ts";
import { completeItem, requeueItem } from "../store.ts";
import { buildInvestigationOptions, buildInvestigationPrompt } from "../task-type-workflow.ts";
import {
  buildCommitMessage,
  buildTaskPrompt,
  resolveAuditPaths,
  resolveAutoRequeue,
  resolveCompletionAction,
  resolveMergeAction,
  resolvePostClaudeAction,
  resolveWorkSetup,
} from "../worker-workflow.ts";
import { processEngineeringItem } from "./worker-engineering.ts";
import {
  type LogFn,
  createLogger,
  mergeAndPush,
  orchestrateWorktreeSetup,
  teardownWorktree,
} from "./worker-shared.ts";

export interface WorkerDeps {
  git?: GitGateway;
  claude?: ClaudeGateway;
  fs?: FsGateway;
  shell?: ShellGateway;
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

    // A non-zero exit with no captured result almost always means Claude
    // never ran (argv / environment / startup error). Auto-requeue those so
    // the queue heals without operator intervention. Items that produced any
    // real result stay wedged at in_progress on purpose — there's probably
    // something worth reading before the operator decides whether to retry.
    const autoRequeue = resolveAutoRequeue(exitCode, result);
    if (autoRequeue.shouldAutoRequeue) {
      try {
        await requeueItem(item.id, autoRequeue.reason, agentName);
        log(`Auto-requeued: ${item.title} (${autoRequeue.reason}).`);
      } catch (err) {
        log(`Auto-requeue failed: ${err instanceof Error ? err.message : String(err)}`);
        log(`Use 'hopper requeue ${item.id} --reason "..."' to retry.`);
      }
    } else {
      log(`Use 'hopper requeue ${item.id} --reason "..."' to retry.`);
    }
  }
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
  if (item.type === "investigation") {
    const prompt = buildInvestigationPrompt(item);
    const options = buildInvestigationOptions();
    log(`Starting investigation session (opus, read-only)...\nAudit log: ${auditFile}`);
    return claude.runSession(prompt, workDir ?? process.cwd(), auditFile, options);
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
  if (item.type === "engineering" && !item.command) {
    return processEngineeringItem(item, agentName, hopperHome, deps, concurrency);
  }
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
