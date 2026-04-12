import type { MergeOutcome } from "./gateways/git-gateway.ts";

// ---------------------------------------------------------------------------
// Branch setup
// ---------------------------------------------------------------------------

export type BranchCheckResult = {
  localExists: boolean;
  remoteExists: boolean;
};

export type BranchSetupAction =
  | { type: "use-existing" }
  | { type: "track-remote"; remoteRef: string }
  | { type: "create-from-head" };

/**
 * Decide how to ensure the target branch exists locally before creating a
 * worktree on top of it.
 *
 * - Local branch present → use it as-is.
 * - No local branch but remote exists → create a tracking branch.
 * - Neither local nor remote → create from HEAD.
 */
export function resolveBranchSetup(
  targetBranch: string,
  check: BranchCheckResult,
): BranchSetupAction {
  if (check.localExists) {
    return { type: "use-existing" };
  }
  if (check.remoteExists) {
    return { type: "track-remote", remoteRef: `origin/${targetBranch}` };
  }
  return { type: "create-from-head" };
}

/**
 * Derive the work branch name from the item ID.
 *
 * Uses the first 8 characters of the UUID to keep branch names short while
 * remaining traceable to the originating queue item.
 */
export function buildWorkBranchName(itemId: string): string {
  return `hopper/${itemId.slice(0, 8)}`;
}

/**
 * Derive the work-branch name for an engineering item.
 *
 * When the caller has a Haiku-generated slug we produce
 * `hopper-eng/<slug>-<id-prefix>` so humans can tell branches apart at a
 * glance. When the slug is missing (e.g. Haiku returned junk) we fall back to
 * `hopper-eng/<id-prefix>` — uninformative but unambiguous, and we never block
 * the workflow on a string-generation failure.
 */
export function buildEngineeringBranchName(itemId: string, slug: string | null): string {
  const prefix = itemId.slice(0, 8);
  if (!slug) return `hopper-eng/${prefix}`;
  return `hopper-eng/${slug}-${prefix}`;
}

// ---------------------------------------------------------------------------
// Merge orchestration
// ---------------------------------------------------------------------------

export type MergeContext = {
  workBranch: string;
  targetBranch: string;
};

export type MergeStepAction =
  | { type: "attempt-ff" }
  | { type: "checkout-and-attempt-ff"; originalBranch: string }
  | { type: "ff-succeeded"; outcome: MergeOutcome }
  | { type: "attempt-merge-commit" }
  | { type: "merge-commit-succeeded"; outcome: MergeOutcome }
  | { type: "conflict-abort"; outcome: MergeOutcome };

/**
 * Decide how to proceed with the merge.
 *
 * When the target branch is already checked out, merge directly. When HEAD
 * points elsewhere, the caller must checkout the target first (and restore the
 * original branch afterwards).
 */
export function resolveMergeStep(currentBranch: string, targetBranch: string): MergeStepAction {
  if (currentBranch !== targetBranch) {
    return { type: "checkout-and-attempt-ff", originalBranch: currentBranch };
  }
  return { type: "attempt-ff" };
}

/**
 * Interpret the exit code of a `git merge --ff-only` attempt.
 *
 * Exit 0 means the fast-forward succeeded. Anything else means the histories
 * have diverged and a merge commit is required.
 */
export function resolveFfResult(ffExitCode: number, ctx: MergeContext): MergeStepAction {
  if (ffExitCode === 0) {
    return {
      type: "ff-succeeded",
      outcome: {
        type: "fast-forward",
        success: true,
        message: `Fast-forward merged ${ctx.workBranch} → ${ctx.targetBranch}; work branch deleted.`,
      },
    };
  }
  return { type: "attempt-merge-commit" };
}

/**
 * Interpret the exit code of a `git merge --no-ff` attempt.
 *
 * Exit 0 means the merge commit was created. Anything else means there are
 * conflicts that require manual resolution.
 */
export function resolveMergeCommitResult(
  mergeExitCode: number,
  ctx: MergeContext,
): MergeStepAction {
  if (mergeExitCode === 0) {
    return {
      type: "merge-commit-succeeded",
      outcome: {
        type: "merge-commit",
        success: true,
        message: `Merge-commit merged ${ctx.workBranch} → ${ctx.targetBranch}; work branch deleted.`,
      },
    };
  }
  return {
    type: "conflict-abort",
    outcome: {
      type: "conflict",
      success: false,
      message: `Merge conflict merging ${ctx.workBranch} → ${ctx.targetBranch}; merge aborted, work branch preserved for manual resolution.`,
    },
  };
}
