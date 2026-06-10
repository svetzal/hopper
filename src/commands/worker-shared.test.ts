import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import type { FsGateway } from "../gateways/fs-gateway.ts";
import { ok } from "../result.ts";
import type { Item } from "../store.ts";
import * as storeModule from "../store.ts";
import { makeClaimedItem, makeMockGit } from "../test-helpers.ts";
import {
  createLogger,
  finalizeCompletion,
  mergeAndPush,
  orchestrateMerge,
  orchestrateWorktreeSetup,
  StaleEngineeringBranchError,
  teardownWorktree,
} from "./worker-shared.ts";

mock.module("../store.ts", () => ({
  ...storeModule,
  completeItem: mock(async () =>
    ok({
      completed: { id: "x", title: "done", status: "completed", createdAt: "" } as Item,
      recurred: undefined,
    }),
  ),
}));

const ITEM_ID = "aaaaaaaa-0000-0000-0000-000000000000";
const REPO_DIR = "/repo";
const WORKTREE_PATH = "/worktrees/work";
const TARGET_BRANCH = "main";
const WORK_BRANCH = "hopper/aaaaaaaa";

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

    await orchestrateWorktreeSetup({
      git,
      repoDir: REPO_DIR,
      branch: TARGET_BRANCH,
      worktreePath: WORKTREE_PATH,
      itemId: ITEM_ID,
    });

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

    await orchestrateWorktreeSetup({
      git,
      repoDir: REPO_DIR,
      branch: TARGET_BRANCH,
      worktreePath: WORKTREE_PATH,
      itemId: ITEM_ID,
    });

    expect(git.createBranch).toHaveBeenCalledWith(REPO_DIR, TARGET_BRANCH);
    expect(git.createTrackingBranch).not.toHaveBeenCalled();
  });

  test("use-existing: neither createBranch nor createTrackingBranch called when local=true", async () => {
    const git = makeMockGit({
      branchExists: mock(async () => true),
      remoteBranchExists: mock(async () => false),
    });

    await orchestrateWorktreeSetup({
      git,
      repoDir: REPO_DIR,
      branch: TARGET_BRANCH,
      worktreePath: WORKTREE_PATH,
      itemId: ITEM_ID,
    });

    expect(git.createBranch).not.toHaveBeenCalled();
    expect(git.createTrackingBranch).not.toHaveBeenCalled();
  });

  test("createWorktree called with derived work branch name in all cases", async () => {
    const git = makeMockGit({
      branchExists: mock(async () => true),
    });

    await orchestrateWorktreeSetup({
      git,
      repoDir: REPO_DIR,
      branch: TARGET_BRANCH,
      worktreePath: WORKTREE_PATH,
      itemId: ITEM_ID,
    });

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

    await orchestrateWorktreeSetup({
      git,
      repoDir: REPO_DIR,
      branch: TARGET_BRANCH,
      worktreePath: WORKTREE_PATH,
      itemId: ITEM_ID,
      workBranchOverride: override,
    });

    expect(git.createWorktree).toHaveBeenCalledWith(
      REPO_DIR,
      WORKTREE_PATH,
      override,
      TARGET_BRANCH,
    );
  });

  test("returns the work branch name used", async () => {
    const git = makeMockGit({ branchExists: mock(async () => true) });

    const result = await orchestrateWorktreeSetup({
      git,
      repoDir: REPO_DIR,
      branch: TARGET_BRANCH,
      worktreePath: WORKTREE_PATH,
      itemId: ITEM_ID,
    });

    expect(result).toBe("hopper/aaaaaaaa");
  });

  // Branch-collision tolerance cases ----------------------------------------

  test("work branch absent → no forceDeleteBranch call, createWorktree called normally", async () => {
    // Target branch exists locally; work branch does NOT exist
    const git = makeMockGit({
      branchExists: mock(async (_, branch) => branch === TARGET_BRANCH),
    });
    const override = "hopper-eng/my-slug-aaaaaaaa";

    await orchestrateWorktreeSetup({
      git,
      repoDir: REPO_DIR,
      branch: TARGET_BRANCH,
      worktreePath: WORKTREE_PATH,
      itemId: ITEM_ID,
      workBranchOverride: override,
    });

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

    await orchestrateWorktreeSetup({
      git,
      repoDir: REPO_DIR,
      branch: TARGET_BRANCH,
      worktreePath: WORKTREE_PATH,
      itemId: ITEM_ID,
      workBranchOverride: workBranch,
    });

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
      orchestrateWorktreeSetup({
        git,
        repoDir: REPO_DIR,
        branch: TARGET_BRANCH,
        worktreePath: WORKTREE_PATH,
        itemId: ITEM_ID,
        workBranchOverride: workBranch,
      }),
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
      orchestrateWorktreeSetup({
        git,
        repoDir: REPO_DIR,
        branch: TARGET_BRANCH,
        worktreePath: WORKTREE_PATH,
        itemId: ITEM_ID,
        workBranchOverride: workBranch,
      }),
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

    const result = await orchestrateWorktreeSetup({
      git,
      repoDir: REPO_DIR,
      branch: TARGET_BRANCH,
      worktreePath: WORKTREE_PATH,
      itemId: ITEM_ID,
      workBranchOverride: workBranch,
      log: (msg) => logs.push(msg),
    });

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
      orchestrateWorktreeSetup({
        git,
        repoDir: REPO_DIR,
        branch: TARGET_BRANCH,
        worktreePath: WORKTREE_PATH,
        itemId: ITEM_ID,
        workBranchOverride: workBranch,
      }),
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
      orchestrateWorktreeSetup({
        git,
        repoDir: REPO_DIR,
        branch: TARGET_BRANCH,
        worktreePath: WORKTREE_PATH,
        itemId: ITEM_ID,
        workBranchOverride: workBranch,
      }),
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
// finalizeCompletion
// ---------------------------------------------------------------------------

describe("finalizeCompletion", () => {
  function makeMockFs(): FsGateway {
    return {
      ensureDir: mock(async () => {}),
      writeFile: mock(async () => {}),
    };
  }

  test("writes result file before marking complete", async () => {
    const fs = makeMockFs();
    const calls: string[] = [];
    (fs.writeFile as ReturnType<typeof mock>).mockImplementation(async () => {
      calls.push("writeFile");
    });

    const { completeItem } = await import("../store.ts");
    (completeItem as ReturnType<typeof mock>).mockImplementation(async () => {
      calls.push("completeItem");
      return ok({
        completed: { id: "x", title: "done", status: "completed", createdAt: "" } as Item,
        recurred: undefined,
      });
    });

    await finalizeCompletion({
      fs,
      resultFile: "/tmp/result.txt",
      finalResult: "all done",
      claimToken: "tok-abc",
      agentName: "test-agent",
      log: () => {},
    });

    expect(calls).toEqual(["writeFile", "completeItem"]);
    expect(fs.writeFile as ReturnType<typeof mock>).toHaveBeenCalledWith(
      "/tmp/result.txt",
      "all done",
    );
  });

  test("calls writeFile with resultFile and finalResult", async () => {
    const fs = makeMockFs();

    await finalizeCompletion({
      fs,
      resultFile: "/path/to/result",
      finalResult: "task output",
      claimToken: "tok-xyz",
      agentName: "agent-1",
      log: () => {},
    });

    expect(fs.writeFile as ReturnType<typeof mock>).toHaveBeenCalledWith(
      "/path/to/result",
      "task output",
    );
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

// ---------------------------------------------------------------------------
// Step 9 — mergeAbort failure: original branch still restored
// ---------------------------------------------------------------------------

describe("orchestrateMerge additional error paths", () => {
  test("mergeAbort throws: exception propagates but original branch is still restored", async () => {
    const git = makeMockGit({
      getCurrentBranch: mock(async () => "feature"),
      mergeFastForward: mock(async () => 1),
      mergeCommit: mock(async () => 1),
      mergeAbort: mock(async () => {
        throw new Error("mergeAbort failed: index locked");
      }),
    });

    await expect(orchestrateMerge(git, REPO_DIR, TARGET_BRANCH, WORK_BRANCH)).rejects.toThrow(
      "mergeAbort failed: index locked",
    );

    // Despite mergeAbort throwing, the finally block restores the original branch
    const checkoutMock = git.checkout as ReturnType<typeof mock>;
    const calls = checkoutMock.mock.calls as string[][];
    const restoreCall = calls.find((c) => c[1] === "feature");
    expect(restoreCall).toBeDefined();
  });

  // ---------------------------------------------------------------------------
  // Step 11 — Checkout failure during merge: no merge attempted, branch restored
  // ---------------------------------------------------------------------------

  test("checkout to target branch fails: no merge attempted, original branch restored, exception thrown", async () => {
    const git = makeMockGit({
      getCurrentBranch: mock(async () => "feature"),
      checkout: mock(async (_repoDir: string, branch: string) => {
        if (branch === TARGET_BRANCH) throw new Error("checkout failed: working tree dirty");
      }),
      mergeFastForward: mock(async () => 0),
    });

    await expect(orchestrateMerge(git, REPO_DIR, TARGET_BRANCH, WORK_BRANCH)).rejects.toThrow(
      "checkout failed: working tree dirty",
    );

    expect(git.mergeFastForward).not.toHaveBeenCalled();

    const checkoutMock = git.checkout as ReturnType<typeof mock>;
    const calls = checkoutMock.mock.calls as [string, string][];
    // First call: checkout to target (threw), second call: restore "feature"
    expect(calls).toHaveLength(2);
    expect(calls[0]?.[1]).toBe(TARGET_BRANCH);
    expect(calls[1]?.[1]).toBe("feature");
  });
});

// ---------------------------------------------------------------------------
// Step 10 — Multiple worktrees: StaleEngineeringBranchError
// ---------------------------------------------------------------------------

describe("orchestrateWorktreeSetup additional collision cases", () => {
  test("work branch has 2+ active worktrees → throws StaleEngineeringBranchError", async () => {
    const workBranch = "hopper-eng/my-slug-aaaaaaaa";
    const git = makeMockGit({
      branchExists: mock(async () => true),
      listWorktreesForBranch: mock(async () => ["/worktrees/one", "/worktrees/two"]),
    });

    await expect(
      orchestrateWorktreeSetup({
        git,
        repoDir: REPO_DIR,
        branch: TARGET_BRANCH,
        worktreePath: WORKTREE_PATH,
        itemId: ITEM_ID,
        workBranchOverride: workBranch,
      }),
    ).rejects.toBeInstanceOf(StaleEngineeringBranchError);

    expect(git.createWorktree).not.toHaveBeenCalled();
    expect(git.branchIsAncestorOf).not.toHaveBeenCalled();
  });
});
