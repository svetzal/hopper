import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import type { ClaudeGateway } from "../gateways/claude-gateway.ts";
import type { FsGateway } from "../gateways/fs-gateway.ts";
import type { GitGateway } from "../gateways/git-gateway.ts";
import type { ShellGateway } from "../gateways/shell-gateway.ts";
import type { Item } from "../store.ts";
// Mock the store module so processItem doesn't touch the real items.json
import * as store from "../store.ts";
import { makeClaimedItem, setupTempStoreDir } from "./test-helpers.ts";
import { processItem } from "./worker.ts";

// Capture the real requeueItem BEFORE mock.module rewires the module registry.
// The module-level mock below delegates to this captured reference so that
// other test files which rely on the real implementation (notably
// src/commands/requeue.test.ts) continue to see real behaviour — each test
// file sets its own temp store dir via `setupTempStoreDir`, so this
// pass-through is safe across the whole suite.
const realRequeueItem = store.requeueItem;

mock.module("../store.ts", () => ({
  ...store,
  completeItem: mock(async () => ({
    completed: { title: "done" } as Item,
    recurred: undefined,
  })),
  recordItemPhase: mock(async () => {}),
  requeueItem: mock(async (id: string, reason: string, agent?: string) =>
    realRequeueItem(id, reason, agent),
  ),
}));
const { completeItem, recordItemPhase, requeueItem } = await import("../store.ts");
const completeItemMock = completeItem as ReturnType<typeof mock>;
const recordItemPhaseMock = recordItemPhase as ReturnType<typeof mock>;
const requeueItemMock = requeueItem as ReturnType<typeof mock>;

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
    getCurrentBranch: mock(async () => "main"),
    checkout: mock(async () => {}),
    mergeFastForward: mock(async () => 0),
    mergeCommit: mock(async () => 0),
    mergeAbort: mock(async () => {}),
    deleteBranch: mock(async () => {}),
    push: mock(async () => ({ success: true, message: "Pushed main to origin." })),
    pushTags: mock(async () => ({ success: true, message: "Pushed tags to origin." })),
    diffSummary: mock(
      async () => " src/foo.ts | 2 +-\n\ndiff --git a/src/foo.ts b/src/foo.ts\n+changed line",
    ),
    ...overrides,
  };
}

function makeMockClaude(exitCode = 0, result = "Done."): ClaudeGateway {
  return {
    runSession: mock(async () => ({ exitCode, result })),
    generateText: mock(async () => ({ exitCode: 0, text: "stub-slug" })),
  };
}

function makeMockShell(exitCode = 0, result = "Done."): ShellGateway {
  return {
    runCommand: mock(async () => ({ exitCode, result })),
  };
}

function makeMockFs(): FsGateway {
  return {
    ensureDir: mock(async () => {}),
    writeFile: mock(async () => {}),
  };
}

const HOPPER_HOME = "/tmp/test-hopper";

describe("processItem", () => {
  // Isolate the store so the pass-through requeueItem mock can't touch the
  // user's real ~/.hopper/items.json. The temp dir is set up per-test and
  // torn down afterwards.
  const storeDir = setupTempStoreDir("hopper-worker-test-");

  beforeEach(async () => {
    await storeDir.beforeEach();
    completeItemMock.mockClear();
    recordItemPhaseMock.mockClear();
    requeueItemMock.mockClear();
  });

  afterEach(storeDir.afterEach);

  test("completes a simple item (no worktree) successfully", async () => {
    const item = makeClaimedItem();
    const git = makeMockGit();
    const claude = makeMockClaude(0, "All done.");
    const fs = makeMockFs();

    await processItem(item, "test-agent", HOPPER_HOME, { git, claude, fs, shell: makeMockShell() });

    expect(claude.runSession).toHaveBeenCalledTimes(1);
    expect(completeItemMock).toHaveBeenCalledWith("tok-1234", "test-agent", "All done.");
    // No worktree operations
    expect(git.createWorktree).not.toHaveBeenCalled();
    expect(git.worktreeRemove).not.toHaveBeenCalled();
  });

  test("does not complete when Claude exits non-zero", async () => {
    const item = makeClaimedItem();
    const claude = makeMockClaude(1, "Failed.");
    const fs = makeMockFs();
    const git = makeMockGit();

    await processItem(item, "test-agent", HOPPER_HOME, { git, claude, fs, shell: makeMockShell() });

    expect(completeItemMock).not.toHaveBeenCalled();
  });

  test("auto-requeues when Claude exits non-zero with the no-result sentinel (startup failure)", async () => {
    const item = makeClaimedItem();
    // Seed the temp store with the claimed item so the pass-through
    // requeueItem can find and transition it.
    await store.saveItems([item]);
    const claude = makeMockClaude(1, "(see audit log for details)");
    const fs = makeMockFs();
    const git = makeMockGit();

    await processItem(item, "test-agent", HOPPER_HOME, { git, claude, fs, shell: makeMockShell() });

    expect(completeItemMock).not.toHaveBeenCalled();
    expect(requeueItemMock).toHaveBeenCalledTimes(1);
    const call = (requeueItemMock.mock.calls as unknown[][])[0] as unknown[];
    expect(call[0]).toBe(item.id);
    expect(call[1] as string).toContain("exited 1");

    // And the pass-through actually transitioned the item back to queued
    const reloaded = await store.loadItems();
    const refreshed = reloaded.find((i) => i.id === item.id);
    expect(refreshed?.status).toBe("queued");
    expect(refreshed?.requeueReason).toContain("exited 1");
  });

  test("does NOT auto-requeue when Claude exits non-zero with a real captured result", async () => {
    const item = makeClaimedItem();
    const claude = makeMockClaude(1, "Partial work. Ran into X before dying.");
    const fs = makeMockFs();
    const git = makeMockGit();

    await processItem(item, "test-agent", HOPPER_HOME, { git, claude, fs, shell: makeMockShell() });

    expect(completeItemMock).not.toHaveBeenCalled();
    expect(requeueItemMock).not.toHaveBeenCalled();
  });

  test("does not auto-requeue on Claude success even if result happens to be empty", async () => {
    const item = makeClaimedItem();
    const claude = makeMockClaude(0, "");
    const fs = makeMockFs();
    const git = makeMockGit();

    await processItem(item, "test-agent", HOPPER_HOME, { git, claude, fs, shell: makeMockShell() });

    expect(completeItemMock).toHaveBeenCalledTimes(1);
    expect(requeueItemMock).not.toHaveBeenCalled();
  });

  test("sets up worktree when item has workingDir and branch", async () => {
    const item = makeClaimedItem({ workingDir: "/repo", branch: "main" });
    const git = makeMockGit();
    const claude = makeMockClaude();
    const fs = makeMockFs();

    await processItem(item, "test-agent", HOPPER_HOME, { git, claude, fs, shell: makeMockShell() });

    expect(git.createWorktree).toHaveBeenCalledTimes(1);
    expect(git.worktreeRemove).toHaveBeenCalledTimes(1);
    expect(git.mergeFastForward).toHaveBeenCalledTimes(1);
  });

  test("commits directly when worktree is dirty after Claude session", async () => {
    const item = makeClaimedItem({ workingDir: "/repo", branch: "main" });
    const git = makeMockGit();
    (git.isWorktreeDirty as ReturnType<typeof mock>).mockImplementation(async () => true);
    const claude = makeMockClaude(0, "Fixed the bug.");
    const fs = makeMockFs();

    await processItem(item, "test-agent", HOPPER_HOME, { git, claude, fs, shell: makeMockShell() });

    // Only one Claude session — no auto-commit session
    expect(claude.runSession).toHaveBeenCalledTimes(1);
    // Hopper commits directly with item title + Claude summary
    expect(git.commitAll).toHaveBeenCalledTimes(1);
    const commitMsg = (git.commitAll as ReturnType<typeof mock>).mock.calls[0]?.[1];
    expect(commitMsg).toContain("Test task");
    expect(commitMsg).toContain("Fixed the bug.");
  });

  test("two concurrent processItem calls don't interfere", async () => {
    const item1 = makeClaimedItem({
      id: "11111111-0000-0000-0000-000000000000",
      title: "Task 1",
      claimToken: "tok-1",
    });
    const item2 = makeClaimedItem({
      id: "22222222-0000-0000-0000-000000000000",
      title: "Task 2",
      claimToken: "tok-2",
    });

    const completedTokens: string[] = [];
    completeItemMock.mockImplementation(async (token: string) => {
      completedTokens.push(token);
      return { completed: { title: "done" } as Item, recurred: undefined };
    });

    // Create independent mocks for each to prove isolation
    const git = makeMockGit();
    const fs = makeMockFs();

    let _resolve1: () => void;
    let _resolve2: () => void;
    const claude: ClaudeGateway = {
      runSession: mock(async () => {
        // Introduce a small async gap to test true concurrency
        await new Promise<void>((r) => setTimeout(r, 10));
        return { exitCode: 0, result: "Done." };
      }),
      generateText: mock(async () => ({ exitCode: 0, text: "stub" })),
    };

    // Run both concurrently
    await Promise.all([
      processItem(item1, "agent", HOPPER_HOME, { git, claude, fs, shell: makeMockShell() }, 2),
      processItem(item2, "agent", HOPPER_HOME, { git, claude, fs, shell: makeMockShell() }, 2),
    ]);

    // Both should have completed
    expect(completedTokens).toContain("tok-1");
    expect(completedTokens).toContain("tok-2");
    expect(completedTokens).toHaveLength(2);
  });

  test("uses prefixed logging when concurrency > 1", async () => {
    const item = makeClaimedItem({ id: "abcdef12-0000-0000-0000-000000000000" });
    const git = makeMockGit();
    const claude = makeMockClaude();
    const fs = makeMockFs();

    const logs: string[] = [];
    const origLog = console.log;
    console.log = (...args: unknown[]) => logs.push(args.join(" "));

    try {
      await processItem(
        item,
        "test-agent",
        HOPPER_HOME,
        { git, claude, fs, shell: makeMockShell() },
        2,
      );
    } finally {
      console.log = origLog;
    }

    // All log lines from processItem should be prefixed with [abcdef12]
    const prefixedLines = logs.filter((l) => l.startsWith("[abcdef12]"));
    expect(prefixedLines.length).toBeGreaterThan(0);
    // No unprefixed lines from processItem (except possibly from completeItem mock)
    const unprefixedProcessLines = logs.filter((l) => !l.startsWith("[abcdef12]"));
    expect(unprefixedProcessLines).toHaveLength(0);
  });

  test("does not prefix logs when concurrency is 1", async () => {
    const item = makeClaimedItem({ id: "abcdef12-0000-0000-0000-000000000000" });
    const git = makeMockGit();
    const claude = makeMockClaude();
    const fs = makeMockFs();

    const logs: string[] = [];
    const origLog = console.log;
    console.log = (...args: unknown[]) => logs.push(args.join(" "));

    try {
      await processItem(
        item,
        "test-agent",
        HOPPER_HOME,
        { git, claude, fs, shell: makeMockShell() },
        1,
      );
    } finally {
      console.log = origLog;
    }

    const prefixedLines = logs.filter((l) => l.startsWith("["));
    expect(prefixedLines).toHaveLength(0);
  });

  test("runs shell command instead of Claude when item has command field", async () => {
    const item = makeClaimedItem({ command: "echo hello" });
    const git = makeMockGit();
    const claude = makeMockClaude();
    const shell = makeMockShell(0, "hello");
    const fs = makeMockFs();

    await processItem(item, "test-agent", HOPPER_HOME, { git, claude, fs, shell });

    expect(shell.runCommand).toHaveBeenCalledTimes(1);
    expect(claude.runSession).not.toHaveBeenCalled();
    expect(completeItemMock).toHaveBeenCalledWith("tok-1234", "test-agent", "hello");
  });

  test("does not complete when shell command exits non-zero", async () => {
    const item = makeClaimedItem({ command: "exit 1" });
    const git = makeMockGit();
    const claude = makeMockClaude();
    const shell = makeMockShell(1, "error output");
    const fs = makeMockFs();

    await processItem(item, "test-agent", HOPPER_HOME, { git, claude, fs, shell });

    expect(shell.runCommand).toHaveBeenCalledTimes(1);
    expect(claude.runSession).not.toHaveBeenCalled();
    expect(completeItemMock).not.toHaveBeenCalled();
  });

  test("shell command with worktree sets up and tears down worktree", async () => {
    const item = makeClaimedItem({ command: "make build", workingDir: "/repo", branch: "main" });
    const git = makeMockGit();
    const claude = makeMockClaude();
    const shell = makeMockShell(0, "build complete");
    const fs = makeMockFs();

    await processItem(item, "test-agent", HOPPER_HOME, { git, claude, fs, shell });

    expect(git.createWorktree).toHaveBeenCalledTimes(1);
    expect(git.worktreeRemove).toHaveBeenCalledTimes(1);
    expect(shell.runCommand).toHaveBeenCalledTimes(1);
    expect(claude.runSession).not.toHaveBeenCalled();
    expect(completeItemMock).toHaveBeenCalled();
  });

  test("shell command with only workingDir (no branch) runs in that directory", async () => {
    const item = makeClaimedItem({ command: "ls", workingDir: "/some/dir" });
    const git = makeMockGit();
    const claude = makeMockClaude();
    const shell = makeMockShell(0, "file1 file2");
    const fs = makeMockFs();

    await processItem(item, "test-agent", HOPPER_HOME, { git, claude, fs, shell });

    expect(git.createWorktree).not.toHaveBeenCalled();
    expect(shell.runCommand).toHaveBeenCalledTimes(1);
    const callArgs = (shell.runCommand as ReturnType<typeof mock>).mock.calls[0] as unknown[];
    expect(callArgs[0]).toBe("ls");
    expect(callArgs[1]).toBe("/some/dir");
  });

  test("branch setup tracks remote when local absent and remote exists", async () => {
    const item = makeClaimedItem({ workingDir: "/repo", branch: "main" });
    const git = makeMockGit({
      branchExists: mock(async () => false),
      remoteBranchExists: mock(async () => true),
    });
    const claude = makeMockClaude();
    const fs = makeMockFs();

    await processItem(item, "test-agent", HOPPER_HOME, { git, claude, fs, shell: makeMockShell() });

    expect(git.createTrackingBranch).toHaveBeenCalledTimes(1);
    expect(git.createBranch).not.toHaveBeenCalled();
  });

  test("branch setup creates from HEAD when neither local nor remote exists", async () => {
    const item = makeClaimedItem({ workingDir: "/repo", branch: "main" });
    const git = makeMockGit({
      branchExists: mock(async () => false),
      remoteBranchExists: mock(async () => false),
    });
    const claude = makeMockClaude();
    const fs = makeMockFs();

    await processItem(item, "test-agent", HOPPER_HOME, { git, claude, fs, shell: makeMockShell() });

    expect(git.createBranch).toHaveBeenCalledTimes(1);
    expect(git.createTrackingBranch).not.toHaveBeenCalled();
  });

  test("branch setup uses existing branch when it exists locally", async () => {
    const item = makeClaimedItem({ workingDir: "/repo", branch: "main" });
    const git = makeMockGit({
      branchExists: mock(async () => true),
    });
    const claude = makeMockClaude();
    const fs = makeMockFs();

    await processItem(item, "test-agent", HOPPER_HOME, { git, claude, fs, shell: makeMockShell() });

    expect(git.createTrackingBranch).not.toHaveBeenCalled();
    expect(git.createBranch).not.toHaveBeenCalled();
  });

  test("merge checks out target branch when not currently checked out, then restores original", async () => {
    const item = makeClaimedItem({ workingDir: "/repo", branch: "main" });
    const checkoutCalls: string[] = [];
    const git = makeMockGit({
      getCurrentBranch: mock(async () => "develop"),
      checkout: mock(async (_dir: string, branch: string) => {
        checkoutCalls.push(branch);
      }),
    });
    const claude = makeMockClaude();
    const fs = makeMockFs();

    await processItem(item, "test-agent", HOPPER_HOME, { git, claude, fs, shell: makeMockShell() });

    expect(git.mergeFastForward).toHaveBeenCalledTimes(1);
    expect(checkoutCalls).toEqual(["main", "develop"]);
  });

  test("pushes tags after successful merge and push", async () => {
    const item = makeClaimedItem({ workingDir: "/repo", branch: "main" });
    const git = makeMockGit();
    const claude = makeMockClaude();
    const fs = makeMockFs();

    await processItem(item, "test-agent", HOPPER_HOME, { git, claude, fs, shell: makeMockShell() });

    expect(git.pushTags).toHaveBeenCalledTimes(1);
    expect(git.pushTags).toHaveBeenCalledWith("/repo");
  });

  test("warns but does not fail when tag push fails", async () => {
    const item = makeClaimedItem({ workingDir: "/repo", branch: "main" });
    const git = makeMockGit({
      pushTags: mock(async () => ({ success: false, message: "Tag push failed: error" })),
    });
    const claude = makeMockClaude();
    const fs = makeMockFs();

    await processItem(item, "test-agent", HOPPER_HOME, { git, claude, fs, shell: makeMockShell() });

    // Item should still complete despite tag push failure
    expect(completeItemMock).toHaveBeenCalled();
    expect(git.pushTags).toHaveBeenCalledTimes(1);
  });

  test("does not push tags when merge fails (conflict)", async () => {
    const item = makeClaimedItem({ workingDir: "/repo", branch: "main" });
    const git = makeMockGit({
      mergeFastForward: mock(async () => 1),
      mergeCommit: mock(async () => 1),
    });
    const claude = makeMockClaude();
    const fs = makeMockFs();

    await processItem(item, "test-agent", HOPPER_HOME, { git, claude, fs, shell: makeMockShell() });

    expect(git.pushTags).not.toHaveBeenCalled();
  });

  test("does not push tags for items without worktree", async () => {
    const item = makeClaimedItem();
    const git = makeMockGit();
    const claude = makeMockClaude();
    const fs = makeMockFs();

    await processItem(item, "test-agent", HOPPER_HOME, { git, claude, fs, shell: makeMockShell() });

    expect(git.pushTags).not.toHaveBeenCalled();
  });

  test("merge aborts and preserves work branch on conflict", async () => {
    const item = makeClaimedItem({ workingDir: "/repo", branch: "main" });
    const git = makeMockGit({
      mergeFastForward: mock(async () => 1),
      mergeCommit: mock(async () => 1),
    });
    const claude = makeMockClaude();
    const fs = makeMockFs();

    await processItem(item, "test-agent", HOPPER_HOME, { git, claude, fs, shell: makeMockShell() });

    expect(git.mergeAbort).toHaveBeenCalledTimes(1);
    expect(git.deleteBranch).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // Engineering type: phased orchestration
  // -------------------------------------------------------------------------

  /**
   * Build a Claude mock whose `runSession` replies are driven by the prompt
   * content so a single mock can serve all three phases. `generateText`
   * (Haiku) returns a stable slug + commit message.
   */
  function makeEngineeringClaude(overrides?: {
    planExit?: number;
    planResult?: string;
    executeExit?: number;
    executeResult?: string;
    validateExit?: number;
    validateResult?: string;
    slug?: string;
    commitMessage?: string;
  }): ClaudeGateway {
    const o = {
      planExit: 0,
      planResult: "## Approach\nEdit src/cli.ts\n\n## Validation\nbun test",
      executeExit: 0,
      executeResult: "Implemented the change.",
      validateExit: 0,
      validateResult: "All checks green.\n\nVALIDATE: PASS",
      slug: "add-quiet-flag",
      commitMessage: "Add --quiet flag\n\nSilence info logs.",
      ...overrides,
    };
    return {
      runSession: mock(async (prompt: string) => {
        if (prompt.includes("PLANNING phase")) {
          return { exitCode: o.planExit, result: o.planResult };
        }
        if (prompt.includes("EXECUTE phase")) {
          return { exitCode: o.executeExit, result: o.executeResult };
        }
        if (prompt.includes("VALIDATE phase")) {
          return { exitCode: o.validateExit, result: o.validateResult };
        }
        return { exitCode: 0, result: "unknown prompt" };
      }),
      generateText: mock(async (prompt: string) => {
        if (prompt.toLowerCase().includes("kebab-case")) {
          return { exitCode: 0, text: o.slug };
        }
        // Commit-message prompt
        return { exitCode: 0, text: o.commitMessage };
      }),
    };
  }

  test("engineering: runs plan → execute → validate and commits on PASS", async () => {
    const item = makeClaimedItem({
      type: "engineering",
      workingDir: "/repo",
      branch: "main",
      agent: "typescript-bun-cli-craftsperson",
    });
    const git = makeMockGit({
      isWorktreeDirty: mock(async () => true),
    });
    const claude = makeEngineeringClaude();
    const fs = makeMockFs();

    await processItem(item, "test-agent", HOPPER_HOME, {
      git,
      claude,
      fs,
      shell: makeMockShell(),
    });

    // All three phases ran
    expect(claude.runSession).toHaveBeenCalledTimes(3);
    // Haiku called twice: slug + commit message
    expect(claude.generateText).toHaveBeenCalledTimes(2);
    // Hopper-driven commit happened with the Haiku message
    expect(git.commitAll).toHaveBeenCalledTimes(1);
    const commitMsg = (git.commitAll as ReturnType<typeof mock>).mock.calls[0]?.[1];
    expect(commitMsg).toContain("Add --quiet flag");
    // Merge + push happened
    expect(git.mergeFastForward).toHaveBeenCalledTimes(1);
    expect(git.push).toHaveBeenCalledTimes(1);
    // Item completed
    expect(completeItemMock).toHaveBeenCalledTimes(1);
  });

  test("engineering: uses engineering branch name with slug from Haiku", async () => {
    const item = makeClaimedItem({
      type: "engineering",
      workingDir: "/repo",
      branch: "main",
    });
    const git = makeMockGit({ isWorktreeDirty: mock(async () => true) });
    const claude = makeEngineeringClaude({ slug: "refactor-parser" });
    const fs = makeMockFs();

    await processItem(item, "test-agent", HOPPER_HOME, {
      git,
      claude,
      fs,
      shell: makeMockShell(),
    });

    const workBranchArg = (git.createWorktree as ReturnType<typeof mock>).mock
      .calls[0]?.[2] as string;
    expect(workBranchArg.startsWith("hopper-eng/refactor-parser-")).toBe(true);
  });

  test("engineering: falls back to bare id-prefix branch when Haiku slug call fails", async () => {
    const item = makeClaimedItem({
      type: "engineering",
      workingDir: "/repo",
      branch: "main",
    });
    const git = makeMockGit({ isWorktreeDirty: mock(async () => true) });
    const claude: ClaudeGateway = {
      runSession: mock(async (prompt: string) => {
        if (prompt.includes("PLANNING phase")) return { exitCode: 0, result: "plan" };
        if (prompt.includes("EXECUTE phase")) return { exitCode: 0, result: "executed" };
        return { exitCode: 0, result: "VALIDATE: PASS" };
      }),
      generateText: mock(async () => ({ exitCode: 1, text: "" })),
    };
    const fs = makeMockFs();

    await processItem(item, "test-agent", HOPPER_HOME, {
      git,
      claude,
      fs,
      shell: makeMockShell(),
    });

    const workBranchArg = (git.createWorktree as ReturnType<typeof mock>).mock
      .calls[0]?.[2] as string;
    // hopper-eng/<id-prefix> with no slug segment
    expect(workBranchArg).toMatch(/^hopper-eng\/[a-f0-9]{8}$/);
  });

  test("engineering: persists plan.md to audit dir, not the worktree", async () => {
    const item = makeClaimedItem({
      type: "engineering",
      workingDir: "/repo",
      branch: "main",
    });
    const git = makeMockGit({ isWorktreeDirty: mock(async () => true) });
    const claude = makeEngineeringClaude();
    const fs = makeMockFs();

    await processItem(item, "test-agent", HOPPER_HOME, {
      git,
      claude,
      fs,
      shell: makeMockShell(),
    });

    const writeCalls = (fs.writeFile as ReturnType<typeof mock>).mock.calls as unknown[][];
    const planWrite = writeCalls.find((c) => (c[0] as string).endsWith("-plan.md"));
    expect(planWrite).toBeDefined();
    expect((planWrite?.[0] as string).startsWith(HOPPER_HOME)).toBe(true);
    // Ensure nothing was written inside the worktree directory
    const worktreeWrite = writeCalls.find((c) => (c[0] as string).includes("/worktrees/"));
    expect(worktreeWrite).toBeUndefined();
  });

  test("engineering: stops at plan and does not commit when plan phase fails", async () => {
    const item = makeClaimedItem({
      type: "engineering",
      workingDir: "/repo",
      branch: "main",
    });
    const git = makeMockGit({ isWorktreeDirty: mock(async () => true) });
    const claude = makeEngineeringClaude({ planExit: 1, planResult: "Plan crashed." });
    const fs = makeMockFs();

    await processItem(item, "test-agent", HOPPER_HOME, {
      git,
      claude,
      fs,
      shell: makeMockShell(),
    });

    // Only the plan phase ran
    expect(claude.runSession).toHaveBeenCalledTimes(1);
    expect(git.commitAll).not.toHaveBeenCalled();
    expect(git.mergeFastForward).not.toHaveBeenCalled();
    // Worktree NOT torn down — preserved for inspection
    expect(git.worktreeRemove).not.toHaveBeenCalled();
    expect(completeItemMock).not.toHaveBeenCalled();
  });

  test("engineering: stops at execute and preserves worktree on non-zero execute exit", async () => {
    const item = makeClaimedItem({
      type: "engineering",
      workingDir: "/repo",
      branch: "main",
    });
    const git = makeMockGit({ isWorktreeDirty: mock(async () => true) });
    const claude = makeEngineeringClaude({ executeExit: 2, executeResult: "broke" });
    const fs = makeMockFs();

    await processItem(item, "test-agent", HOPPER_HOME, {
      git,
      claude,
      fs,
      shell: makeMockShell(),
    });

    // Plan + execute ran; validate did not
    expect(claude.runSession).toHaveBeenCalledTimes(2);
    expect(git.commitAll).not.toHaveBeenCalled();
    expect(git.worktreeRemove).not.toHaveBeenCalled();
    expect(completeItemMock).not.toHaveBeenCalled();
  });

  test("engineering: does not commit or merge when validate reports FAIL (retries=0)", async () => {
    const item = makeClaimedItem({
      type: "engineering",
      workingDir: "/repo",
      branch: "main",
      retries: 0,
    });
    const git = makeMockGit({ isWorktreeDirty: mock(async () => true) });
    const claude = makeEngineeringClaude({
      validateResult: "Lint errors.\n\nVALIDATE: FAIL",
    });
    const fs = makeMockFs();

    await processItem(item, "test-agent", HOPPER_HOME, {
      git,
      claude,
      fs,
      shell: makeMockShell(),
    });

    expect(claude.runSession).toHaveBeenCalledTimes(3);
    expect(git.commitAll).not.toHaveBeenCalled();
    expect(git.mergeFastForward).not.toHaveBeenCalled();
    // Worktree preserved
    expect(git.worktreeRemove).not.toHaveBeenCalled();
  });

  test("engineering: treats missing PASS/FAIL marker as a failure", async () => {
    const item = makeClaimedItem({
      type: "engineering",
      workingDir: "/repo",
      branch: "main",
    });
    const git = makeMockGit({ isWorktreeDirty: mock(async () => true) });
    const claude = makeEngineeringClaude({ validateResult: "Seems OK to me." });
    const fs = makeMockFs();

    await processItem(item, "test-agent", HOPPER_HOME, {
      git,
      claude,
      fs,
      shell: makeMockShell(),
    });

    expect(git.commitAll).not.toHaveBeenCalled();
    expect(git.mergeFastForward).not.toHaveBeenCalled();
  });

  test("engineering: skips commit when worktree is clean but still tears down and completes", async () => {
    const item = makeClaimedItem({
      type: "engineering",
      workingDir: "/repo",
      branch: "main",
    });
    const git = makeMockGit({ isWorktreeDirty: mock(async () => false) });
    const claude = makeEngineeringClaude();
    const fs = makeMockFs();

    await processItem(item, "test-agent", HOPPER_HOME, {
      git,
      claude,
      fs,
      shell: makeMockShell(),
    });

    expect(git.commitAll).not.toHaveBeenCalled();
    // No commit → no merge
    expect(git.mergeFastForward).not.toHaveBeenCalled();
    // Haiku commit-message call was NOT made (we skipped commit entirely)
    const generateCalls = (claude.generateText as ReturnType<typeof mock>).mock
      .calls as unknown[][];
    const commitMsgCall = generateCalls.find((c) =>
      (c[0] as string).toLowerCase().includes("conventional-commit"),
    );
    expect(commitMsgCall).toBeUndefined();
    // Item still completed
    expect(completeItemMock).toHaveBeenCalledTimes(1);
    // Worktree torn down
    expect(git.worktreeRemove).toHaveBeenCalledTimes(1);
  });

  test("engineering: execute phase receives the plan text inline", async () => {
    const item = makeClaimedItem({
      type: "engineering",
      workingDir: "/repo",
      branch: "main",
    });
    const git = makeMockGit({ isWorktreeDirty: mock(async () => true) });
    const planText = "## Approach\nUse a single flag check in cli.ts";
    const claude = makeEngineeringClaude({ planResult: planText });
    const fs = makeMockFs();

    await processItem(item, "test-agent", HOPPER_HOME, {
      git,
      claude,
      fs,
      shell: makeMockShell(),
    });

    const sessionCalls = (claude.runSession as ReturnType<typeof mock>).mock.calls as unknown[][];
    const executeCall = sessionCalls.find((c) => (c[0] as string).includes("EXECUTE phase"));
    expect(executeCall).toBeDefined();
    expect(executeCall?.[0] as string).toContain(planText);
  });

  test("engineering: forwards the resolved agent to the execute phase options", async () => {
    const item = makeClaimedItem({
      type: "engineering",
      workingDir: "/repo",
      branch: "main",
      agent: "rust-craftsperson",
    });
    const git = makeMockGit({ isWorktreeDirty: mock(async () => true) });
    const claude = makeEngineeringClaude();
    const fs = makeMockFs();

    await processItem(item, "test-agent", HOPPER_HOME, {
      git,
      claude,
      fs,
      shell: makeMockShell(),
    });

    const sessionCalls = (claude.runSession as ReturnType<typeof mock>).mock.calls as unknown[][];
    const executeCall = sessionCalls.find((c) => (c[0] as string).includes("EXECUTE phase"));
    const executeOptions = executeCall?.[3] as { agent?: string } | undefined;
    expect(executeOptions?.agent).toBe("rust-craftsperson");
  });

  test("engineering: records a phase entry after each phase finishes", async () => {
    const item = makeClaimedItem({
      type: "engineering",
      workingDir: "/repo",
      branch: "main",
    });
    const git = makeMockGit({ isWorktreeDirty: mock(async () => true) });
    const claude = makeEngineeringClaude();
    const fs = makeMockFs();

    await processItem(item, "test-agent", HOPPER_HOME, {
      git,
      claude,
      fs,
      shell: makeMockShell(),
    });

    expect(recordItemPhaseMock).toHaveBeenCalledTimes(3);
    const recorded = (recordItemPhaseMock.mock.calls as unknown[][]).map(
      (c) => c[1] as { name: string; exitCode: number; passed?: boolean },
    );
    expect(recorded.map((r) => r.name)).toEqual(["plan", "execute", "validate"]);
    expect(recorded[0]?.exitCode).toBe(0);
    expect(recorded[2]?.passed).toBe(true);
  });

  test("engineering: validate phase record carries passed: false when FAIL marker emitted", async () => {
    const item = makeClaimedItem({
      type: "engineering",
      workingDir: "/repo",
      branch: "main",
    });
    const git = makeMockGit({ isWorktreeDirty: mock(async () => true) });
    const claude = makeEngineeringClaude({
      validateResult: "Lint errors.\n\nVALIDATE: FAIL",
    });
    const fs = makeMockFs();

    await processItem(item, "test-agent", HOPPER_HOME, {
      git,
      claude,
      fs,
      shell: makeMockShell(),
    });

    const validateCall = (recordItemPhaseMock.mock.calls as unknown[][]).find(
      (c) => (c[1] as { name: string }).name === "validate",
    );
    expect((validateCall?.[1] as { passed: boolean }).passed).toBe(false);
  });

  test("engineering: does not record execute or validate phases when plan phase fails", async () => {
    const item = makeClaimedItem({
      type: "engineering",
      workingDir: "/repo",
      branch: "main",
    });
    const git = makeMockGit({ isWorktreeDirty: mock(async () => false) });
    const claude = makeEngineeringClaude({ planExit: 1, planResult: "crashed" });
    const fs = makeMockFs();

    await processItem(item, "test-agent", HOPPER_HOME, {
      git,
      claude,
      fs,
      shell: makeMockShell(),
    });

    const recorded = (recordItemPhaseMock.mock.calls as unknown[][]).map(
      (c) => (c[1] as { name: string }).name,
    );
    expect(recorded).toEqual(["plan"]);
  });

  test("engineering: retries once by default after validate FAIL, then passes on retry", async () => {
    const item = makeClaimedItem({
      type: "engineering",
      workingDir: "/repo",
      branch: "main",
    });
    const git = makeMockGit({ isWorktreeDirty: mock(async () => true) });
    // First validate fails, second passes. Prompt differs by phase.
    let validateCalls = 0;
    const claude: ClaudeGateway = {
      runSession: mock(async (prompt: string) => {
        if (prompt.includes("PLANNING phase")) return { exitCode: 0, result: "plan-text" };
        if (prompt.includes("EXECUTE phase")) return { exitCode: 0, result: "ran execute" };
        if (prompt.includes("VALIDATE phase")) {
          validateCalls += 1;
          return validateCalls === 1
            ? { exitCode: 0, result: "Lint errors.\n\nVALIDATE: FAIL" }
            : { exitCode: 0, result: "All good.\n\nVALIDATE: PASS" };
        }
        return { exitCode: 0, result: "" };
      }),
      generateText: mock(async () => ({ exitCode: 0, text: "slug-or-msg" })),
    };
    const fs = makeMockFs();

    await processItem(item, "test-agent", HOPPER_HOME, {
      git,
      claude,
      fs,
      shell: makeMockShell(),
    });

    // plan + execute(1) + validate(1) + execute(2) + validate(2) = 5
    expect(claude.runSession).toHaveBeenCalledTimes(5);
    // Commit ran — the PASS on retry is the green gate
    expect(git.commitAll).toHaveBeenCalledTimes(1);
    expect(git.mergeFastForward).toHaveBeenCalledTimes(1);
    expect(completeItemMock).toHaveBeenCalledTimes(1);
  });

  test("engineering: remediation prompt inlines prior execute + validate output", async () => {
    const item = makeClaimedItem({
      type: "engineering",
      workingDir: "/repo",
      branch: "main",
    });
    const git = makeMockGit({ isWorktreeDirty: mock(async () => true) });
    let validateCalls = 0;
    const claude: ClaudeGateway = {
      runSession: mock(async (prompt: string) => {
        if (prompt.includes("PLANNING phase")) return { exitCode: 0, result: "plan-text" };
        if (prompt.includes("EXECUTE phase"))
          return { exitCode: 0, result: "first-execute-summary" };
        if (prompt.includes("VALIDATE phase")) {
          validateCalls += 1;
          return validateCalls === 1
            ? { exitCode: 0, result: "failing-validate-output\nVALIDATE: FAIL" }
            : { exitCode: 0, result: "VALIDATE: PASS" };
        }
        return { exitCode: 0, result: "" };
      }),
      generateText: mock(async () => ({ exitCode: 0, text: "slug" })),
    };
    const fs = makeMockFs();

    await processItem(item, "test-agent", HOPPER_HOME, {
      git,
      claude,
      fs,
      shell: makeMockShell(),
    });

    const calls = (claude.runSession as ReturnType<typeof mock>).mock.calls as unknown[][];
    const remediationCall = calls.find(
      (c) => (c[0] as string).includes("EXECUTE phase") && (c[0] as string).includes("remediation"),
    );
    expect(remediationCall).toBeDefined();
    const prompt = remediationCall?.[0] as string;
    expect(prompt).toContain("first-execute-summary");
    expect(prompt).toContain("failing-validate-output");
  });

  test("engineering: stops after exhausting retries and preserves worktree", async () => {
    const item = makeClaimedItem({
      type: "engineering",
      workingDir: "/repo",
      branch: "main",
      retries: 2,
    });
    const git = makeMockGit({ isWorktreeDirty: mock(async () => true) });
    // All validate attempts FAIL
    const claude = makeEngineeringClaude({
      validateResult: "still broken\n\nVALIDATE: FAIL",
    });
    const fs = makeMockFs();

    await processItem(item, "test-agent", HOPPER_HOME, {
      git,
      claude,
      fs,
      shell: makeMockShell(),
    });

    // plan + 3 * (execute + validate) = 7
    expect(claude.runSession).toHaveBeenCalledTimes(7);
    expect(git.commitAll).not.toHaveBeenCalled();
    expect(git.mergeFastForward).not.toHaveBeenCalled();
    // Worktree preserved for inspection
    expect(git.worktreeRemove).not.toHaveBeenCalled();
    expect(completeItemMock).not.toHaveBeenCalled();
  });

  test("engineering: retries=0 disables remediation (single execute+validate)", async () => {
    const item = makeClaimedItem({
      type: "engineering",
      workingDir: "/repo",
      branch: "main",
      retries: 0,
    });
    const git = makeMockGit({ isWorktreeDirty: mock(async () => true) });
    const claude = makeEngineeringClaude({
      validateResult: "broken\n\nVALIDATE: FAIL",
    });
    const fs = makeMockFs();

    await processItem(item, "test-agent", HOPPER_HOME, {
      git,
      claude,
      fs,
      shell: makeMockShell(),
    });

    // plan + execute + validate = 3; no retry
    expect(claude.runSession).toHaveBeenCalledTimes(3);
    expect(git.commitAll).not.toHaveBeenCalled();
  });

  test("engineering: retry audit files use -N suffix for attempts ≥ 2", async () => {
    const item = makeClaimedItem({
      id: "11111111-2222-3333-4444-555555555555",
      type: "engineering",
      workingDir: "/repo",
      branch: "main",
      retries: 1,
    });
    const git = makeMockGit({ isWorktreeDirty: mock(async () => true) });
    let vc = 0;
    const claude: ClaudeGateway = {
      runSession: mock(async (prompt: string) => {
        if (prompt.includes("PLANNING phase")) return { exitCode: 0, result: "plan" };
        if (prompt.includes("EXECUTE phase")) return { exitCode: 0, result: "exec" };
        if (prompt.includes("VALIDATE phase")) {
          vc += 1;
          return vc === 1
            ? { exitCode: 0, result: "VALIDATE: FAIL" }
            : { exitCode: 0, result: "VALIDATE: PASS" };
        }
        return { exitCode: 0, result: "" };
      }),
      generateText: mock(async () => ({ exitCode: 0, text: "slug" })),
    };
    const fs = makeMockFs();

    await processItem(item, "test-agent", HOPPER_HOME, {
      git,
      claude,
      fs,
      shell: makeMockShell(),
    });

    const calls = (claude.runSession as ReturnType<typeof mock>).mock.calls as unknown[][];
    const auditPaths = calls.map((c) => c[2] as string);
    expect(auditPaths).toContain(`${HOPPER_HOME}/audit/${item.id}-execute.jsonl`);
    expect(auditPaths).toContain(`${HOPPER_HOME}/audit/${item.id}-validate.jsonl`);
    expect(auditPaths).toContain(`${HOPPER_HOME}/audit/${item.id}-execute-2.jsonl`);
    expect(auditPaths).toContain(`${HOPPER_HOME}/audit/${item.id}-validate-2.jsonl`);
  });

  test("engineering: records execute + validate phases with attempt numbers", async () => {
    const item = makeClaimedItem({
      type: "engineering",
      workingDir: "/repo",
      branch: "main",
      retries: 1,
    });
    const git = makeMockGit({ isWorktreeDirty: mock(async () => true) });
    let vc = 0;
    const claude: ClaudeGateway = {
      runSession: mock(async (prompt: string) => {
        if (prompt.includes("PLANNING phase")) return { exitCode: 0, result: "plan" };
        if (prompt.includes("EXECUTE phase")) return { exitCode: 0, result: "exec" };
        if (prompt.includes("VALIDATE phase")) {
          vc += 1;
          return vc === 1
            ? { exitCode: 0, result: "VALIDATE: FAIL" }
            : { exitCode: 0, result: "VALIDATE: PASS" };
        }
        return { exitCode: 0, result: "" };
      }),
      generateText: mock(async () => ({ exitCode: 0, text: "slug" })),
    };
    const fs = makeMockFs();

    await processItem(item, "test-agent", HOPPER_HOME, {
      git,
      claude,
      fs,
      shell: makeMockShell(),
    });

    const recorded = (recordItemPhaseMock.mock.calls as unknown[][]).map(
      (c) => c[1] as { name: string; attempt?: number; passed?: boolean },
    );
    expect(recorded.map((r) => `${r.name}@${r.attempt ?? 1}`)).toEqual([
      "plan@1",
      "execute@1",
      "validate@1",
      "execute@2",
      "validate@2",
    ]);
    expect(recorded.find((r) => r.name === "validate" && r.attempt === 1)?.passed).toBe(false);
    expect(recorded.find((r) => r.name === "validate" && r.attempt === 2)?.passed).toBe(true);
  });

  test("engineering: writes per-phase audit files under ~/.hopper/audit", async () => {
    const item = makeClaimedItem({
      id: "abcdef12-1111-2222-3333-444444444444",
      type: "engineering",
      workingDir: "/repo",
      branch: "main",
    });
    const git = makeMockGit({ isWorktreeDirty: mock(async () => true) });
    const claude = makeEngineeringClaude();
    const fs = makeMockFs();

    await processItem(item, "test-agent", HOPPER_HOME, {
      git,
      claude,
      fs,
      shell: makeMockShell(),
    });

    const runCalls = (claude.runSession as ReturnType<typeof mock>).mock.calls as unknown[][];
    const auditPaths = runCalls.map((c) => c[2] as string);
    expect(auditPaths).toContain(`${HOPPER_HOME}/audit/${item.id}-plan.jsonl`);
    expect(auditPaths).toContain(`${HOPPER_HOME}/audit/${item.id}-execute.jsonl`);
    expect(auditPaths).toContain(`${HOPPER_HOME}/audit/${item.id}-validate.jsonl`);
  });
});
