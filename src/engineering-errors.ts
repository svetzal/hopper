/**
 * Thrown by `orchestrateWorktreeSetup` when the computed work branch already
 * exists and cannot be safely reclaimed.
 *
 * Two cases trigger this:
 * 1. The branch is still checked out in an active worktree.
 * 2. The branch has diverged from the target branch (its tip is not descended
 *    from the target branch HEAD), meaning it may contain real work.
 *
 * The caller should requeue the item with an explanatory reason so the
 * operator can inspect and resolve the stale branch manually.
 */
export class StaleEngineeringBranchError extends Error {
  constructor(
    public readonly branch: string,
    public readonly worktreePaths: string[],
  ) {
    super(
      worktreePaths.length > 0
        ? `Work branch "${branch}" is still referenced by active worktrees: ${worktreePaths.join(", ")}.`
        : `Work branch "${branch}" already exists but has diverged from the target branch; cannot safely reclaim.`,
    );
    this.name = "StaleEngineeringBranchError";
  }
}
