import { join } from "node:path";
import type { Item } from "./store.ts";

// ---------------------------------------------------------------------------
// Work setup
// ---------------------------------------------------------------------------

export type WorkSetup =
  | { type: "worktree"; repoDir: string; branch: string; worktreePath: string }
  | { type: "existing-dir"; dir: string }
  | { type: "cwd" };

/**
 * Decide where Claude should do its work based on the item's metadata.
 *
 * - Items with both `workingDir` and `branch` get an isolated git worktree.
 * - Items with only `workingDir` run directly in that directory.
 * - All other items run in the current working directory.
 */
export function resolveWorkSetup(item: Item, hopperHome: string): WorkSetup {
  if (item.workingDir && item.branch) {
    return {
      type: "worktree",
      repoDir: item.workingDir,
      branch: item.branch,
      worktreePath: join(hopperHome, "worktrees", item.id),
    };
  }
  if (item.workingDir) {
    return { type: "existing-dir", dir: item.workingDir };
  }
  return { type: "cwd" };
}

// ---------------------------------------------------------------------------
// Prompt builders
// ---------------------------------------------------------------------------

/**
 * Build the prompt that instructs Claude to complete the task described by
 * the item.
 */
export function buildTaskPrompt(item: Item): string {
  return (
    `You have been assigned the following task:\n\n` +
    `Title: ${item.title}\n` +
    `Description: ${item.description}\n\n` +
    `## Instructions\n\n` +
    `1. Analyze the task and plan your approach before writing code.\n` +
    `2. Implement the changes described above.\n` +
    `3. Before finishing, validate your work:\n` +
    `   - Run the project's test suite and ensure all tests pass.\n` +
    `   - Run the project's linter/type checker and fix any errors.\n` +
    `   - If the task description specifies additional validation steps, run those too.\n` +
    `   - If any checks fail, fix the issues before declaring done.\n` +
    `4. Do NOT commit your changes — the caller will handle committing.\n` +
    `5. Provide a clear summary of what you did, including validation results.\n`
  );
}

/**
 * Build a conventional commit message from the item and Claude's summary.
 *
 * Format:
 *   <title>
 *
 *   <summary>
 */
export function buildCommitMessage(item: Item, claudeResult: string): string {
  const body = claudeResult.trim();
  if (body) {
    return `${item.title}\n\n${body}`;
  }
  return item.title;
}

// ---------------------------------------------------------------------------
// Post-Claude decisions
// ---------------------------------------------------------------------------

/**
 * Decide whether Hopper should commit changes on Claude's behalf.
 *
 * Committing only makes sense when the work ran inside a worktree (so git
 * status is scoped to that branch) and there are uncommitted changes.
 */
export function resolvePostClaudeAction(
  hasWorktree: boolean,
  isWorktreeDirty: boolean,
): { shouldCommit: boolean } {
  return { shouldCommit: hasWorktree && isWorktreeDirty };
}

/**
 * Decide whether to merge the work branch back to the target branch.
 *
 * Merging only happens when Claude exited cleanly, a work branch was created,
 * and the item carries both a repo directory and a target branch name.
 */
export function resolveMergeAction(
  claudeExitCode: number,
  workBranch: string | undefined,
  item: Item,
): { shouldMerge: boolean } {
  const shouldMerge = claudeExitCode === 0 && !!workBranch && !!item.workingDir && !!item.branch;
  return { shouldMerge };
}

// ---------------------------------------------------------------------------
// Completion decision
// ---------------------------------------------------------------------------

export type CompletionAction =
  | { action: "complete"; result: string }
  | { action: "failed"; result: string };

/**
 * Decide whether to mark the item complete or leave it for manual requeue,
 * and compose the final result text.
 */
export function resolveCompletionAction(
  claudeExitCode: number,
  claudeResult: string,
  mergeNote: string,
): CompletionAction {
  const result = claudeResult + mergeNote;
  return claudeExitCode === 0 ? { action: "complete", result } : { action: "failed", result };
}

// ---------------------------------------------------------------------------
// Worker config
// ---------------------------------------------------------------------------

export interface WorkerConfig {
  agentName: string;
  pollInterval: number;
  runOnce: boolean;
  concurrency: number;
}

export function resolveWorkerConfig(flags: Record<string, string | boolean>): WorkerConfig {
  return {
    agentName: typeof flags.agent === "string" ? flags.agent : "claude-worker",
    pollInterval: typeof flags.interval === "string" ? parseInt(flags.interval, 10) : 60,
    runOnce: flags.once === true,
    concurrency: typeof flags.concurrency === "string" ? parseInt(flags.concurrency, 10) : 4,
  };
}

// ---------------------------------------------------------------------------
// Loop action
// ---------------------------------------------------------------------------

export type LoopAction =
  | { type: "wait-for-slot" }
  | { type: "claim"; freeSlots: number; shouldLog: boolean }
  | { type: "continue" };

export function resolveLoopAction(
  activeCount: number,
  concurrency: number,
  running: boolean,
): LoopAction {
  if (!running) {
    return { type: "continue" };
  }
  if (activeCount >= concurrency) {
    return { type: "wait-for-slot" };
  }
  const freeSlots = concurrency - activeCount;
  const shouldLog = activeCount === 0;
  return { type: "claim", freeSlots, shouldLog };
}

export type PostClaimAction =
  | { type: "exit-no-work"; message: string }
  | { type: "sleep"; message: string }
  | { type: "wait-and-exit" }
  | { type: "continue" };

export function resolvePostClaimLoopAction(
  activeCount: number,
  claimedAny: boolean,
  runOnce: boolean,
  pollInterval: number,
): PostClaimAction {
  if (activeCount === 0 && !claimedAny) {
    if (runOnce) {
      return { type: "exit-no-work", message: "No work available." };
    }
    return { type: "sleep", message: `No work available. Waiting ${pollInterval}s...` };
  }
  if (runOnce) {
    return { type: "wait-and-exit" };
  }
  return { type: "continue" };
}

// ---------------------------------------------------------------------------
// Shutdown action
// ---------------------------------------------------------------------------

export type ShutdownAction =
  | { type: "already-shutting-down" }
  | { type: "shutdown"; message: string };

export function resolveShutdownAction(
  alreadyShuttingDown: boolean,
  activeCount: number,
): ShutdownAction {
  if (alreadyShuttingDown) {
    return { type: "already-shutting-down" };
  }
  if (activeCount > 0) {
    return {
      type: "shutdown",
      message: `\nShutting down. Waiting for ${activeCount} active task(s) to finish...`,
    };
  }
  return { type: "shutdown", message: "\nShutting down." };
}

// ---------------------------------------------------------------------------
// Audit paths
// ---------------------------------------------------------------------------

export interface AuditPaths {
  auditDir: string;
  auditFile: string;
  resultFile: string;
}

/**
 * Compute the canonical audit file paths for a given item.
 *
 * All audit artefacts live under `<hopperHome>/audit/` so they survive
 * worktree teardown and can be inspected after the fact.
 */
export function resolveAuditPaths(itemId: string, hopperHome: string): AuditPaths {
  const auditDir = join(hopperHome, "audit");
  return {
    auditDir,
    auditFile: join(auditDir, `${itemId}-audit.jsonl`),
    resultFile: join(auditDir, `${itemId}-result.md`),
  };
}
