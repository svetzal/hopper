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
    `Please complete this task. When you are finished, commit your changes ` +
    `with a descriptive commit message and provide a summary of what you did.`
  );
}

/**
 * Build the prompt for a follow-up auto-commit session when Claude left
 * changes uncommitted.
 */
export function buildAutoCommitPrompt(item: Item): string {
  return (
    `A work session just completed on the following task but left uncommitted changes:\n\n` +
    `Title: ${item.title}\n\n` +
    `Please:\n` +
    `1. Review the outstanding changes with \`git diff\` and \`git status\`\n` +
    `2. Stage all changes with \`git add -A\`\n` +
    `3. Commit with a descriptive message summarising what was done\n\n` +
    `Do not make any other changes — only commit what is already there.`
  );
}

// ---------------------------------------------------------------------------
// Post-Claude decisions
// ---------------------------------------------------------------------------

/**
 * Decide whether a follow-up auto-commit session is needed.
 *
 * Auto-commit only makes sense when the work ran inside a worktree (so git
 * status is scoped to that branch) and Claude left changes uncommitted.
 */
export function resolvePostClaudeAction(
  hasWorktree: boolean,
  isWorktreeDirty: boolean,
): { shouldAutoCommit: boolean } {
  return { shouldAutoCommit: hasWorktree && isWorktreeDirty };
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
