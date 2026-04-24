import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import type { GitGateway } from "../gateways/git-gateway.ts";
import { makeClaimedItem } from "./test-helpers.ts";
import {
  createLogger,
  mergeAndPush,
  orchestrateMerge,
  orchestrateWorktreeSetup,
  StaleEngineeringBranchError,
  teardownWorktree,
} from "./worker-shared.ts";

const ITEM_ID = "aaaaaaaa-0000-0000-0000-000000000000";
const REPO_DIR = "/repo";
const WORKTREE_PATH = "/worktrees/work";
const TARGET_BRANCH = "main";
const WORK_BRANCH = "hopper/aaaaaaaa";

function makeMockGit(overrides?: Partial<GitGateway>): GitGateway {
  return {
    branchExists: mock(async () => true),
    remoteBranchExists: mock(async () => false),
    createTrackingBranch: mock(async () => {}),
    createBranch: mock(async () => {}),
    createWorktree: mock(async () => {}),
    worktreeRemove: mock(async () => {}),
    isWorktreeDirty: mock(async () => false),
    commitAll: mock(async () => {}),
    getCurrentBranch: mock(async () => TARGET_BRANCH),
    checkout: mock(async () => {}),
    mergeFastForward: mock(async () => 0),
    mergeCommit: mock(async () => 0),
    mergeAbort: mock(async () => {}),
    mergeNoEdit: mock(async () => ({ exitCode: 0, stderr: "" })),
    deleteBranch: mock(async () => {}),
    push: mock(async () => ({ success: true, message: "Pushed." })),
    pushTags: mock(async () => ({ success: true, message: "Tags pushed." })),
    diffSummary: mock(async () => "src/foo.ts | 2 +-"),
    branchIsAncestorOf: mock(async () => true),
    listWorktreesForBranch: mock(async () => []),
    forceDeleteBranch: mock(async () => {}),
    ...overrides,
  };
}

const noop = () => {};

// ---------------------------------------------------------------------------
// createLogger
// ---------------------------------------------------------------------------

describe("createLogger", () => {
  let consoleSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    consoleSpy = spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    consoleSpy.mockRestore();
  });

  test("prefixes output with [shortId] when concurrency > 1", () => {
    const log = createLogger(ITEM_ID, 2);
    log("hello");
    expect(consoleSpy).toHaveBeenCalledWith("[aaaaaaaa] hello");
  });

  test("logs without prefix when concurrency === 1", () => {
    const log = createLogger(ITEM_ID, 1);
    log("hello");
    expect(consoleSpy).toHaveBeenCalledWith("hello");
  });
});

// ---------------------------------------------------------------------------
// orchestrateWorktreeSetup
// ---------------------------------------------------------------------------

describe("orchestrateWorktreeSetup", () => {
  test("track-remote: creates tracking branch when local=false, remote=true", async () => {
    const git = makeMockGit({
      branchExists: mock(async () => false),
      remoteBranchExists: mock(async () => true),
    });

    await orchestrateWorktreeSetup(git, REPO_DIR, TARGET_BRANCH, WORKTREE_PATH, ITEM_ID);

    expect(git.createTrackingBranch).toHaveBeenCalledWith(
      REPO_DIR,
      TARGET_BRANCH,
      `origin/${TARGET_BRANCH}`,
    );
    expect(git.createBranch).not.toHaveBeenCalled();
  });

  test("create-from-head: creates branch when local=false, remote=false", async () => {
    const git = makeMockGit({
      branchExists: mock(async () => false),
      remoteBranchExists: mock(async () => false),
    });

    await orchestrateWorktreeSetup(git, REPO_DIR, TARGET_BRANCH, WORKTREE_PATH, ITEM_ID);

    expect(git.createBranch).toHaveBeenCalledWith(REPO_DIR, TARGET_BRANCH);
    expect(git.createTrackingBranch).not.toHaveBeenCalled();
  });

  test("use-existing: neither createBranch nor createTrackingBranch called when local=true", async () => {
    const git = makeMockGit({
      branchExists: mock(async () => true),
      remoteBranchExists: mock(async () => false),
    });

    await orchestrateWorktreeSetup(git, REPO_DIR, TARGET_BRANCH, WORKTREE_PATH, ITEM_ID);

    expect(git.createBranch).not.toHaveBeenCalled();
    expect(git.createTrackingBranch).not.toHaveBeenCalled();
  });

  test("createWorktree called with derived work branch name in all cases", async () => {
    const git = makeMockGit({
      branchExists: mock(async () => true),
    });

    await orchestrateWorktreeSetup(git, REPO_DIR, TARGET_BRANCH, WORKTREE_PATH, ITEM_ID);

    expect(git.createWorktree).toHaveBeenCalledWith(
      REPO_DIR,
      WORKTREE_PATH,
      "hopper/aaaaaaaa",
      TARGET_BRANCH,
    );
  });

  test("workBranchOverride is used when provided", async () => {
    const git = makeMockGit({
      branchExists: mock(async () => true),
    });
    const override = "hopper-eng/my-feature-aaaaaaaa";

    await orchestrateWorktreeSetup(git, REPO_DIR, TARGET_BRANCH, WORKTREE_PATH, ITEM_ID, override);

    expect(git.createWorktree).toHaveBeenCalledWith(
      REPO_DIR,
      WORKTREE_PATH,
      override,
      TARGET_BRANCH,
    );
  });

  test("returns the work branch name used", async () => {
    const git = makeMockGit({ branchExists: mock(async () => true) });

    const result = await orchestrateWorktreeSetup(
      git,
      REPO_DIR,
      TARGET_BRANCH,
      WORKTREE_PATH,
      ITEM_ID,
    );

    expect(result).toBe("hopper/aaaaaaaa");
  });

  // Branch-collision tolerance cases ----------------------------------------

  test("work branch absent → no forceDeleteBranch call, createWorktree called normally", async () => {
    // Target branch exists locally; work branch does NOT exist
    const git = makeMockGit({
      branchExists: mock(async (_, branch) => branch === TARGET_BRANCH),
    });
    const override = "hopper-eng/my-slug-aaaaaaaa";

    await orchestrateWorktreeSetup(git, REPO_DIR, TARGET_BRANCH, WORKTREE_PATH, ITEM_ID, override);

    expect(git.forceDeleteBranch).not.toHaveBeenCalled();
    expect(git.createWorktree).toHaveBeenCalledWith(
      REPO_DIR,
      WORKTREE_PATH,
      override,
      TARGET_BRANCH,
    );
  });

  test("work branch exists, no worktrees, safe orphan → forceDeleteBranch called then createWorktree", async () => {
    const workBranch = "hopper-eng/my-slug-aaaaaaaa";
    // Every branch "exists"; no worktrees for the work branch; target IS ancestor
    const git = makeMockGit({
      branchExists: mock(async () => true),
      listWorktreesForBranch: mock(async () => []),
      branchIsAncestorOf: mock(async () => true),
    });

    await orchestrateWorktreeSetup(
      git,
      REPO_DIR,
      TARGET_BRANCH,
      WORKTREE_PATH,
      ITEM_ID,
      workBranch,
    );

    expect(git.forceDeleteBranch).toHaveBeenCalledWith(REPO_DIR, workBranch);
    expect(git.createWorktree).toHaveBeenCalledWith(
      REPO_DIR,
      WORKTREE_PATH,
      workBranch,
      TARGET_BRANCH,
    );
  });

  test("work branch exists, no worktrees, diverged → throws StaleEngineeringBranchError, createWorktree NOT called", async () => {
    const workBranch = "hopper-eng/my-slug-aaaaaaaa";
    const git = makeMockGit({
      branchExists: mock(async () => true),
      listWorktreesForBranch: mock(async () => []),
      branchIsAncestorOf: mock(async () => false), // target NOT ancestor → diverged
    });

    await expect(
      orchestrateWorktreeSetup(git, REPO_DIR, TARGET_BRANCH, WORKTREE_PATH, ITEM_ID, workBranch),
    ).rejects.toBeInstanceOf(StaleEngineeringBranchError);
    expect(git.createWorktree).not.toHaveBeenCalled();
    expect(git.forceDeleteBranch).not.toHaveBeenCalled();
  });

  test("work branch exists with active worktrees → throws StaleEngineeringBranchError, createWorktree NOT called", async () => {
    const workBranch = "hopper-eng/my-slug-aaaaaaaa";
    const git = makeMockGit({
      branchExists: mock(async () => true),
      listWorktreesForBranch: mock(async () => ["/worktrees/active"]),
    });

    await expect(
      orchestrateWorktreeSetup(git, REPO_DIR, TARGET_BRANCH, WORKTREE_PATH, ITEM_ID, workBranch),
    ).rejects.toBeInstanceOf(StaleEngineeringBranchError);
    expect(git.createWorktree).not.toHaveBeenCalled();
    // branchIsAncestorOf should NOT have been called (worktrees check short-circuits)
    expect(git.branchIsAncestorOf).not.toHaveBeenCalled();
  });

  test("same path + clean + no commits ahead → reuses worktree, createWorktree NOT called", async () => {
    const workBranch = "hopper-eng/my-slug-aaaaaaaa";
    const git = makeMockGit({
      branchExists: mock(async () => true),
      // One worktree at the exact same path as the argument
      listWorktreesForBranch: mock(async () => [WORKTREE_PATH]),
      isWorktreeDirty: mock(async () => false),
      // workBranch IS ancestor of target → no commits ahead of target
      branchIsAncestorOf: mock(async () => true),
    });
    const logs: string[] = [];

    const result = await orchestrateWorktreeSetup(
      git,
      REPO_DIR,
      TARGET_BRANCH,
      WORKTREE_PATH,
      ITEM_ID,
      workBranch,
      (msg) => logs.push(msg),
    );

    expect(result).toBe(workBranch);
    expect(git.createWorktree).not.toHaveBeenCalled();
    expect(git.forceDeleteBranch).not.toHaveBeenCalled();
    expect(logs.some((l) => l.includes("Reusing preserved worktree"))).toBe(true);
  });

  test("same path + dirty → throws StaleEngineeringBranchError, createWorktree NOT called", async () => {
    const workBranch = "hopper-eng/my-slug-aaaaaaaa";
    const git = makeMockGit({
      branchExists: mock(async () => true),
      listWorktreesForBranch: mock(async () => [WORKTREE_PATH]),
      isWorktreeDirty: mock(async () => true),
    });

    await expect(
      orchestrateWorktreeSetup(git, REPO_DIR, TARGET_BRANCH, WORKTREE_PATH, ITEM_ID, workBranch),
    ).rejects.toBeInstanceOf(StaleEngineeringBranchError);
    expect(git.createWorktree).not.toHaveBeenCalled();
  });

  test("same path + clean but commits ahead of target → throws StaleEngineeringBranchError, createWorktree NOT called", async () => {
    const workBranch = "hopper-eng/my-slug-aaaaaaaa";
    const git = makeMockGit({
      branchExists: mock(async () => true),
      listWorktreesForBranch: mock(async () => [WORKTREE_PATH]),
      isWorktreeDirty: mock(async () => false),
      // workBranch is NOT ancestor of target → workBranch has commits ahead
      branchIsAncestorOf: mock(async () => false),
    });

    await expect(
      orchestrateWorktreeSetup(git, REPO_DIR, TARGET_BRANCH, WORKTREE_PATH, ITEM_ID, workBranch),
    ).rejects.toBeInstanceOf(StaleEngineeringBranchError);
    expect(git.createWorktree).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// orchestrateMerge
// ---------------------------------------------------------------------------

describe("orchestrateMerge", () => {
  test("fast-forward success: deleteBranch called and returns fast-forward outcome", async () => {
    const git = makeMockGit({
      getCurrentBranch: mock(async () => TARGET_BRANCH),
      mergeFastForward: mock(async () => 0),
    });

    const result = await orchestrateMerge(git, REPO_DIR, TARGET_BRANCH, WORK_BRANCH);

    expect(git.deleteBranch).toHaveBeenCalledWith(REPO_DIR, WORK_BRANCH);
    expect(result.type).toBe("fast-forward");
    expect(result.success).toBe(true);
  });

  test("merge-commit fallback: FF returns 1, merge-commit returns 0 → deleteBranch called, returns merge-commit", async () => {
    const git = makeMockGit({
      getCurrentBranch: mock(async () => TARGET_BRANCH),
      mergeFastForward: mock(async () => 1),
      mergeCommit: mock(async () => 0),
    });

    const result = await orchestrateMerge(git, REPO_DIR, TARGET_BRANCH, WORK_BRANCH);

    expect(git.deleteBranch).toHaveBeenCalledWith(REPO_DIR, WORK_BRANCH);
    expect(result.type).toBe("merge-commit");
    expect(result.success).toBe(true);
  });

  test("conflict: both FF and merge-commit fail → mergeAbort called, returns conflict outcome", async () => {
    const git = makeMockGit({
      getCurrentBranch: mock(async () => TARGET_BRANCH),
      mergeFastForward: mock(async () => 1),
      mergeCommit: mock(async () => 1),
    });

    const result = await orchestrateMerge(git, REPO_DIR, TARGET_BRANCH, WORK_BRANCH);

    expect(git.mergeAbort).toHaveBeenCalledWith(REPO_DIR);
    expect(git.deleteBranch).not.toHaveBeenCalled();
    expect(result.type).toBe("conflict");
    expect(result.success).toBe(false);
  });

  test("branch restoration: checks out targetBranch before merge when on different branch", async () => {
    const git = makeMockGit({
      getCurrentBranch: mock(async () => "feature"),
      mergeFastForward: mock(async () => 0),
    });

    await orchestrateMerge(git, REPO_DIR, TARGET_BRANCH, WORK_BRANCH);

    const checkoutCalls = (git.checkout as ReturnType<typeof mock>).mock.calls as string[][];
    expect(checkoutCalls[0]).toEqual([REPO_DIR, TARGET_BRANCH]);
    expect(checkoutCalls[1]).toEqual([REPO_DIR, "feature"]);
  });

  test("already on target branch: no initial checkout, no restoration", async () => {
    const git = makeMockGit({
      getCurrentBranch: mock(async () => TARGET_BRANCH),
      mergeFastForward: mock(async () => 0),
    });

    await orchestrateMerge(git, REPO_DIR, TARGET_BRANCH, WORK_BRANCH);

    expect(git.checkout).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// mergeAndPush
// ---------------------------------------------------------------------------

describe("mergeAndPush", () => {
  test("merge succeeds (FF): push and pushTags called, note includes merge message", async () => {
    const git = makeMockGit({
      getCurrentBranch: mock(async () => TARGET_BRANCH),
      mergeFastForward: mock(async () => 0),
      push: mock(async () => ({ success: true, message: "Pushed." })),
      pushTags: mock(async () => ({ success: true, message: "Tags pushed." })),
    });
    const item = makeClaimedItem({ branch: TARGET_BRANCH, workingDir: REPO_DIR });

    const note = await mergeAndPush(git, item, WORK_BRANCH, noop);

    expect(git.push).toHaveBeenCalledWith(REPO_DIR, TARGET_BRANCH);
    expect(git.pushTags).toHaveBeenCalledWith(REPO_DIR);
    expect(note).toContain("Fast-forward");
  });

  test("merge success + push failure: push failure message included in note", async () => {
    const git = makeMockGit({
      getCurrentBranch: mock(async () => TARGET_BRANCH),
      mergeFastForward: mock(async () => 0),
      push: mock(async () => ({ success: false, message: "Push failed: remote rejected." })),
      pushTags: mock(async () => ({ success: true, message: "Tags pushed." })),
    });
    const item = makeClaimedItem({ branch: TARGET_BRANCH, workingDir: REPO_DIR });

    const note = await mergeAndPush(git, item, WORK_BRANCH, noop);

    expect(note).toContain("Push failed: remote rejected.");
  });

  test("merge success + tag push failure: tag failure warning in note", async () => {
    const git = makeMockGit({
      getCurrentBranch: mock(async () => TARGET_BRANCH),
      mergeFastForward: mock(async () => 0),
      push: mock(async () => ({ success: true, message: "Pushed." })),
      pushTags: mock(async () => ({ success: false, message: "Tag push failed: no tags." })),
    });
    const item = makeClaimedItem({ branch: TARGET_BRANCH, workingDir: REPO_DIR });

    const note = await mergeAndPush(git, item, WORK_BRANCH, noop);

    expect(note).toContain("Tag push failed: no tags.");
  });

  test("merge failure (conflict): push NOT called, note includes manual merge instruction", async () => {
    const git = makeMockGit({
      getCurrentBranch: mock(async () => TARGET_BRANCH),
      mergeFastForward: mock(async () => 1),
      mergeCommit: mock(async () => 1),
    });
    const item = makeClaimedItem({ branch: TARGET_BRANCH, workingDir: REPO_DIR });

    const note = await mergeAndPush(git, item, WORK_BRANCH, noop);

    expect(git.push).not.toHaveBeenCalled();
    expect(note).toContain("conflict");
  });
});

// ---------------------------------------------------------------------------
// teardownWorktree
// ---------------------------------------------------------------------------

describe("teardownWorktree", () => {
  test("calls worktreeRemove with correct repoDir and worktreePath", async () => {
    const git = makeMockGit();
    const logs: string[] = [];

    await teardownWorktree(git, REPO_DIR, WORKTREE_PATH, (msg) => logs.push(msg));

    expect(git.worktreeRemove).toHaveBeenCalledWith(REPO_DIR, WORKTREE_PATH);
  });

  test("log function called with 'Removing worktree...'", async () => {
    const git = makeMockGit();
    const logs: string[] = [];

    await teardownWorktree(git, REPO_DIR, WORKTREE_PATH, (msg) => logs.push(msg));

    expect(logs).toContain("Removing worktree...");
  });
});
