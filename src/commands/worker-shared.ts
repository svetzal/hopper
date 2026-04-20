import { shortId } from "../format.ts";
import type { GitGateway, MergeOutcome } from "../gateways/git-gateway.ts";
import {
  buildWorkBranchName,
  resolveBranchSetup,
  resolveFfResult,
  resolveMergeCommitResult,
  resolveMergeStep,
} from "../git-workflow.ts";
import type { Item } from "../store.ts";

export type LogFn = (message: string) => void;

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

export function createLogger(itemId: string, concurrency: number): LogFn {
  if (concurrency > 1) {
    const prefix = `[${shortId(itemId)}]`;
    return (message: string) => console.log(`${prefix} ${message}`);
  }
  return (message: string) => console.log(message);
}

export async function orchestrateWorktreeSetup(
  git: GitGateway,
  repoDir: string,
  branch: string,
  worktreePath: string,
  itemId: string,
  workBranchOverride?: string,
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

  const workBranch = workBranchOverride ?? buildWorkBranchName(itemId);

  // Guard against orphaned work branches left by prior failed attempts.
  const workBranchExists = await git.branchExists(repoDir, workBranch);
  if (workBranchExists) {
    const worktreePaths = await git.listWorktreesForBranch(repoDir, workBranch);
    if (worktreePaths.length > 0) {
      // Branch still checked out in an active worktree — unsafe to touch.
      throw new StaleEngineeringBranchError(workBranch, worktreePaths);
    }
    // No active worktrees. Safe to reclaim only if the work branch tip is
    // descended from the current target branch HEAD (i.e. target is an
    // ancestor of the work branch). This covers the common orphan case where
    // the branch was created but no commits landed before the worker crashed.
    const isSafeOrphan = await git.branchIsAncestorOf(repoDir, branch, workBranch);
    if (!isSafeOrphan) {
      // Branch has diverged — may contain real work; leave it for inspection.
      throw new StaleEngineeringBranchError(workBranch, []);
    }
    // Safe orphan: delete the stale branch so `git worktree add -b` succeeds.
    await git.forceDeleteBranch(repoDir, workBranch);
  }

  await git.createWorktree(repoDir, worktreePath, workBranch, branch);
  return workBranch;
}

export async function orchestrateMerge(
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

export async function mergeAndPush(
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

export async function teardownWorktree(
  git: GitGateway,
  repoDir: string,
  worktreePath: string,
  log: LogFn,
): Promise<void> {
  log("Removing worktree...");
  await git.worktreeRemove(repoDir, worktreePath);
}
