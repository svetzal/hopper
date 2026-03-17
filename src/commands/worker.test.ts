import { describe, expect, test, beforeEach, mock } from "bun:test";
import { processItem } from "./worker.ts";
import type { Item } from "../store.ts";
import type { GitGateway } from "../gateways/git-gateway.ts";
import type { ClaudeGateway } from "../gateways/claude-gateway.ts";
import type { FsGateway } from "../gateways/fs-gateway.ts";
import type { ShellGateway } from "../gateways/shell-gateway.ts";

// Mock the store module so processItem doesn't touch the real items.json
import * as store from "../store.ts";
mock.module("../store.ts", () => ({
  ...store,
  completeItem: mock(async () => ({
    completed: { title: "done" } as Item,
    recurred: undefined,
  })),
}));
const { completeItem } = await import("../store.ts");
const completeItemMock = completeItem as ReturnType<typeof mock>;

function makeItem(overrides?: Partial<Item>): Item {
  return {
    id: "aaaaaaaa-0000-0000-0000-000000000000",
    title: "Test task",
    description: "Do something",
    status: "in_progress",
    createdAt: new Date().toISOString(),
    claimedAt: new Date().toISOString(),
    claimedBy: "test-agent",
    claimToken: "tok-1234",
    ...overrides,
  };
}

function makeMockGit(): GitGateway {
  return {
    worktreeAdd: mock(async () => "hopper/aaaaaaaa"),
    worktreeRemove: mock(async () => {}),
    isWorktreeDirty: mock(async () => false),
    commitAll: mock(async () => {}),
    mergeWorkBranch: mock(async () => ({
      type: "fast-forward" as const,
      success: true as const,
      message: "Merged.",
    })),
    push: mock(async () => ({ success: true, message: "Pushed main to origin." })),
  };
}

function makeMockClaude(exitCode = 0, result = "Done."): ClaudeGateway {
  return {
    runSession: mock(async () => ({ exitCode, result })),
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
  beforeEach(() => {
    completeItemMock.mockClear();
  });

  test("completes a simple item (no worktree) successfully", async () => {
    const item = makeItem();
    const git = makeMockGit();
    const claude = makeMockClaude(0, "All done.");
    const fs = makeMockFs();

    await processItem(item, "test-agent", HOPPER_HOME, { git, claude, fs, shell: makeMockShell() });

    expect(claude.runSession).toHaveBeenCalledTimes(1);
    expect(completeItemMock).toHaveBeenCalledWith("tok-1234", "test-agent", "All done.");
    // No worktree operations
    expect(git.worktreeAdd).not.toHaveBeenCalled();
    expect(git.worktreeRemove).not.toHaveBeenCalled();
  });

  test("does not complete when Claude exits non-zero", async () => {
    const item = makeItem();
    const claude = makeMockClaude(1, "Failed.");
    const fs = makeMockFs();
    const git = makeMockGit();

    await processItem(item, "test-agent", HOPPER_HOME, { git, claude, fs, shell: makeMockShell() });

    expect(completeItemMock).not.toHaveBeenCalled();
  });

  test("sets up worktree when item has workingDir and branch", async () => {
    const item = makeItem({ workingDir: "/repo", branch: "main" });
    const git = makeMockGit();
    const claude = makeMockClaude();
    const fs = makeMockFs();

    await processItem(item, "test-agent", HOPPER_HOME, { git, claude, fs, shell: makeMockShell() });

    expect(git.worktreeAdd).toHaveBeenCalledTimes(1);
    expect(git.worktreeRemove).toHaveBeenCalledTimes(1);
    expect(git.mergeWorkBranch).toHaveBeenCalledTimes(1);
  });

  test("commits directly when worktree is dirty after Claude session", async () => {
    const item = makeItem({ workingDir: "/repo", branch: "main" });
    const git = makeMockGit();
    (git.isWorktreeDirty as ReturnType<typeof mock>).mockImplementation(async () => true);
    const claude = makeMockClaude(0, "Fixed the bug.");
    const fs = makeMockFs();

    await processItem(item, "test-agent", HOPPER_HOME, { git, claude, fs, shell: makeMockShell() });

    // Only one Claude session — no auto-commit session
    expect(claude.runSession).toHaveBeenCalledTimes(1);
    // Hopper commits directly with item title + Claude summary
    expect(git.commitAll).toHaveBeenCalledTimes(1);
    const commitMsg = (git.commitAll as ReturnType<typeof mock>).mock.calls[0]![1];
    expect(commitMsg).toContain("Test task");
    expect(commitMsg).toContain("Fixed the bug.");
  });

  test("two concurrent processItem calls don't interfere", async () => {
    const item1 = makeItem({
      id: "11111111-0000-0000-0000-000000000000",
      title: "Task 1",
      claimToken: "tok-1",
    });
    const item2 = makeItem({
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

    let resolve1: () => void;
    let resolve2: () => void;
    const claude: ClaudeGateway = {
      runSession: mock(async () => {
        // Introduce a small async gap to test true concurrency
        await new Promise<void>((r) => setTimeout(r, 10));
        return { exitCode: 0, result: "Done." };
      }),
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
    const item = makeItem({ id: "abcdef12-0000-0000-0000-000000000000" });
    const git = makeMockGit();
    const claude = makeMockClaude();
    const fs = makeMockFs();

    const logs: string[] = [];
    const origLog = console.log;
    console.log = (...args: unknown[]) => logs.push(args.join(" "));

    try {
      await processItem(item, "test-agent", HOPPER_HOME, { git, claude, fs, shell: makeMockShell() }, 2);
    } finally {
      console.log = origLog;
    }

    // All log lines from processItem should be prefixed with [abcdef12]
    const prefixedLines = logs.filter((l) => l.startsWith("[abcdef12]"));
    expect(prefixedLines.length).toBeGreaterThan(0);
    // No unprefixed lines from processItem (except possibly from completeItem mock)
    const unprefixedProcessLines = logs.filter(
      (l) => !l.startsWith("[abcdef12]"),
    );
    expect(unprefixedProcessLines).toHaveLength(0);
  });

  test("does not prefix logs when concurrency is 1", async () => {
    const item = makeItem({ id: "abcdef12-0000-0000-0000-000000000000" });
    const git = makeMockGit();
    const claude = makeMockClaude();
    const fs = makeMockFs();

    const logs: string[] = [];
    const origLog = console.log;
    console.log = (...args: unknown[]) => logs.push(args.join(" "));

    try {
      await processItem(item, "test-agent", HOPPER_HOME, { git, claude, fs, shell: makeMockShell() }, 1);
    } finally {
      console.log = origLog;
    }

    const prefixedLines = logs.filter((l) => l.startsWith("["));
    expect(prefixedLines).toHaveLength(0);
  });

  test("runs shell command instead of Claude when item has command field", async () => {
    const item = makeItem({ command: "echo hello" });
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
    const item = makeItem({ command: "exit 1" });
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
    const item = makeItem({ command: "make build", workingDir: "/repo", branch: "main" });
    const git = makeMockGit();
    const claude = makeMockClaude();
    const shell = makeMockShell(0, "build complete");
    const fs = makeMockFs();

    await processItem(item, "test-agent", HOPPER_HOME, { git, claude, fs, shell });

    expect(git.worktreeAdd).toHaveBeenCalledTimes(1);
    expect(git.worktreeRemove).toHaveBeenCalledTimes(1);
    expect(shell.runCommand).toHaveBeenCalledTimes(1);
    expect(claude.runSession).not.toHaveBeenCalled();
    expect(completeItemMock).toHaveBeenCalled();
  });

  test("shell command with only workingDir (no branch) runs in that directory", async () => {
    const item = makeItem({ command: "ls", workingDir: "/some/dir" });
    const git = makeMockGit();
    const claude = makeMockClaude();
    const shell = makeMockShell(0, "file1 file2");
    const fs = makeMockFs();

    await processItem(item, "test-agent", HOPPER_HOME, { git, claude, fs, shell });

    expect(git.worktreeAdd).not.toHaveBeenCalled();
    expect(shell.runCommand).toHaveBeenCalledTimes(1);
    const callArgs = (shell.runCommand as ReturnType<typeof mock>).mock.calls[0]!;
    expect(callArgs[0]).toBe("ls");
    expect(callArgs[1]).toBe("/some/dir");
  });
});
