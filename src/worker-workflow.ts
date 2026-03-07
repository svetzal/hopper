import { join } from "path";
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
    `Please complete this task. Do NOT commit your changes — the caller ` +
    `will handle committing. When you are finished, provide a clear summary ` +
    `of what you did.`
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
  const shouldMerge =
    claudeExitCode === 0 && !!workBranch && !!item.workingDir && !!item.branch;
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
  return claudeExitCode === 0
    ? { action: "complete", result }
    : { action: "failed", result };
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
