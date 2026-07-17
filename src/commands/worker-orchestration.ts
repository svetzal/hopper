// Shell functions with 3+ inputs accept one typed args/context object; 1–2 input helpers may stay positional.

import { StaleEngineeringBranchError } from "../engineering-errors.ts";
import { toErrorMessage } from "../error-utils.ts";
import { shortId } from "../format.ts";
import type { AgentRunner } from "../gateways/agent-runner.ts";
import type { FsGateway } from "../gateways/fs-gateway.ts";
import type { GitGateway, MergeOutcome } from "../gateways/git-gateway.ts";
import {
  buildWorkBranchName,
  resolveBranchSetup,
  resolveFfResult,
  resolveMergeCommitResult,
  resolveMergeStep,
} from "../git-workflow.ts";
import type { Profile } from "../profile.ts";
import { type ClaimedItem, completeItem, failItem, requeueItem } from "../store.ts";

export type LogFn = (message: string) => void;

export type WorkerRunnerDeps = {
  git: GitGateway;
  claude: AgentRunner;
  fs: FsGateway;
  profile: Profile;
};

export { StaleEngineeringBranchError };

export async function finalizeCompletion(ctx: {
  fs: FsGateway;
  resultFile: string;
  finalResult: string;
  claimToken: string;
  agentName: string;
  log: LogFn;
}): Promise<void> {
  const { fs, resultFile, finalResult, claimToken, agentName, log } = ctx;
  await fs.writeFile(resultFile, finalResult);
  await logCompleteOutcome(claimToken, agentName, finalResult, log);
}

export async function logCompleteOutcome(
  claimToken: string,
  agentName: string,
  finalResult: string,
  log: LogFn,
): Promise<void> {
  log("Marking item complete...");
  const completeOutcome = await completeItem(claimToken, agentName, finalResult);
  if (completeOutcome.ok) {
    const { completed, recurred } = completeOutcome.value;
    log(`Completed: ${completed.title}`);
    if (recurred) {
      log(
        `Re-queued: ${completed.title} (next run: ${recurred.scheduledAt ? new Date(recurred.scheduledAt).toLocaleString() : "unknown"})`,
      );
    }
  } else {
    log(`Complete failed: ${completeOutcome.error}`);
  }
}

/**
 * Transition a run that ended without integrable work to the terminal `failed`
 * status. The result file has already been written by the failure path; this
 * only records the store transition so the item stops holding its repo's
 * claim slot. The worktree + work branch are deliberately NOT touched —
 * recovery (requeue / integrate / cancel) is a human decision.
 */
export async function finalizeFailure(ctx: {
  claimToken: string;
  agentName: string;
  finalResult: string;
  log: LogFn;
}): Promise<void> {
  const { claimToken, agentName, finalResult, log } = ctx;
  log("Marking item failed...");
  const failOutcome = await failItem(claimToken, agentName, finalResult);
  if (failOutcome.ok) {
    log(
      `Failed: ${failOutcome.value.title} (worktree + branch preserved; requeue, integrate, or cancel to recover)`,
    );
  } else {
    log(`Fail transition failed: ${failOutcome.error}`);
  }
}

export function logClaimBanner(item: ClaimedItem, log: LogFn, extras?: string[]): void {
  log(`Claimed: ${item.title}`);
  log(`Token:   ${item.claimToken}`);
  log(`ID:      ${item.id}`);
  for (const extra of extras ?? []) {
    log(extra);
  }
}

export async function safeVoid(fn: () => Promise<void>, label: string, log: LogFn): Promise<void> {
  try {
    await fn();
  } catch (e) {
    log(`${label}: ${toErrorMessage(e)}`);
  }
}

export async function safeRequeue(
  itemId: string,
  reason: string,
  agentName: string,
  log: LogFn,
): Promise<void> {
  try {
    const outcome = await requeueItem(itemId, reason, agentName);
    if (!outcome.ok) {
      log(`Requeue failed: ${outcome.error}`);
    }
  } catch (e) {
    log(`Requeue failed: ${toErrorMessage(e)}`);
  }
}

export function createLogger(itemId: string, concurrency: number): LogFn {
  if (concurrency > 1) {
    const prefix = `[${shortId(itemId)}]`;
    return (message: string) => console.log(`${prefix} ${message}`);
  }
  return (message: string) => console.log(message);
}

export interface WorktreeSetupContext {
  git: GitGateway;
  repoDir: string;
  branch: string;
  worktreePath: string;
  itemId: string;
  workBranchOverride?: string;
  log?: LogFn;
}

export async function orchestrateWorktreeSetup(ctx: WorktreeSetupContext): Promise<string> {
  const { git, repoDir, branch, worktreePath, itemId, workBranchOverride, log } = ctx;
  const localExists = await git.branchExists(repoDir, branch);
  const remoteExists = await git.remoteBranchExists(repoDir, branch);
  if (remoteExists) {
    log?.(`Fetching origin/${branch}...`);
    await git.fetchBranch(repoDir, branch);
  }
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

  let baseRef = branch;
  if (localExists && remoteExists) {
    const remoteRef = `origin/${branch}`;
    const localContainsRemote = await git.branchIsAncestorOf(repoDir, remoteRef, branch);
    const remoteContainsLocal = await git.branchIsAncestorOf(repoDir, branch, remoteRef);
    if (!localContainsRemote && !remoteContainsLocal) {
      throw new Error(
        `Local ${branch} and ${remoteRef} have diverged; refusing to choose a worktree base automatically.`,
      );
    }
    if (remoteContainsLocal && !localContainsRemote) {
      baseRef = remoteRef;
      log?.(`Using freshly fetched ${remoteRef} as the worktree base.`);
    }
  }

  const workBranch = workBranchOverride ?? buildWorkBranchName(itemId);

  // Guard against orphaned work branches left by prior failed attempts.
  const workBranchExists = await git.branchExists(repoDir, workBranch);
  if (workBranchExists) {
    const worktreePaths = await git.listWorktreesForBranch(repoDir, workBranch);
    if (worktreePaths.length > 0) {
      // Check whether this is a safe-to-reuse preserved worktree:
      // exactly one worktree at the expected path, clean, and no commits ahead of target.
      if (
        worktreePaths.length === 1 &&
        worktreePaths[0] === worktreePath &&
        !(await git.isWorktreeDirty(worktreePath)) &&
        (await git.branchIsAncestorOf(repoDir, workBranch, baseRef))
      ) {
        log?.(
          `Reusing preserved worktree at \`${worktreePath}\` (clean, no commits ahead of \`${branch}\`).`,
        );
        return workBranch;
      }
      // Branch still checked out in an active worktree — unsafe to touch.
      throw new StaleEngineeringBranchError(workBranch, worktreePaths);
    }
    // No active worktrees. Safe to reclaim only if the work branch tip is
    // descended from the current target branch HEAD (i.e. target is an
    // ancestor of the work branch). This covers the common orphan case where
    // the branch was created but no commits landed before the worker crashed.
    const isSafeOrphan = await git.branchIsAncestorOf(repoDir, baseRef, workBranch);
    if (!isSafeOrphan) {
      // Branch has diverged — may contain real work; leave it for inspection.
      throw new StaleEngineeringBranchError(workBranch, []);
    }
    // Safe orphan: delete the stale branch so `git worktree add -b` succeeds.
    await git.forceDeleteBranch(repoDir, workBranch);
  }

  await git.createWorktree(repoDir, worktreePath, workBranch, baseRef);
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
  }

  try {
    if (restoreBranch !== undefined) {
      await git.checkout(repoDir, targetBranch);
    }
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

export async function mergeAndPush(ctx: {
  git: GitGateway;
  repoDir: string;
  targetBranch: string;
  workBranch: string;
  log: LogFn;
}): Promise<string> {
  const { git, repoDir, targetBranch, workBranch, log } = ctx;
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

export async function teardownWorktree(ctx: {
  git: GitGateway;
  repoDir: string;
  worktreePath: string;
  log: LogFn;
}): Promise<void> {
  const { git, repoDir, worktreePath, log } = ctx;
  log("Removing worktree...");
  await git.worktreeRemove(repoDir, worktreePath);
}

export async function finalizeWorktreeAndComplete(ctx: {
  git: GitGateway;
  repoDir: string;
  worktreePath: string;
  workBranch: string;
  targetBranch: string;
  shouldMerge: boolean;
  log: LogFn;
  finalize: (mergeNote: string) => Promise<void>;
}): Promise<void> {
  const { git, repoDir, worktreePath, workBranch, targetBranch, shouldMerge, log, finalize } = ctx;
  await teardownWorktree({ git, repoDir, worktreePath, log });
  let mergeNote = "";
  if (shouldMerge) {
    mergeNote = await mergeAndPush({ git, repoDir, targetBranch, workBranch, log });
  }
  await finalize(mergeNote);
}
