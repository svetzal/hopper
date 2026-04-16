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
