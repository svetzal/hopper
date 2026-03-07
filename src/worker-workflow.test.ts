import { describe, expect, test } from "bun:test";
import {
  resolveWorkSetup,
  buildTaskPrompt,
  buildCommitMessage,
  resolvePostClaudeAction,
  resolveMergeAction,
  resolveCompletionAction,
  resolveAuditPaths,
} from "./worker-workflow.ts";
import type { Item } from "./store.ts";

const HOPPER_HOME = "/home/user/.hopper";

function makeItem(overrides?: Partial<Item>): Item {
  return {
    id: "abcdef12-0000-0000-0000-000000000000",
    title: "Test task",
    description: "A test description",
    status: "queued",
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

describe("worker-workflow", () => {
  describe("resolveWorkSetup", () => {
    test("returns worktree setup when item has workingDir and branch", () => {
      const item = makeItem({ workingDir: "/repo/project", branch: "main" });
      expect(resolveWorkSetup(item, HOPPER_HOME)).toEqual({
        type: "worktree",
        repoDir: "/repo/project",
        branch: "main",
        worktreePath: "/home/user/.hopper/worktrees/abcdef12-0000-0000-0000-000000000000",
      });
    });

    test("returns existing-dir setup when item has workingDir but no branch", () => {
      const item = makeItem({ workingDir: "/repo/project" });
      expect(resolveWorkSetup(item, HOPPER_HOME)).toEqual({
        type: "existing-dir",
        dir: "/repo/project",
      });
    });

    test("returns cwd setup when item has neither workingDir nor branch", () => {
      const item = makeItem();
      expect(resolveWorkSetup(item, HOPPER_HOME)).toEqual({ type: "cwd" });
    });

    test("returns cwd setup when item has branch but no workingDir", () => {
      // branch without workingDir is not actionable — fall back to cwd
      const item = makeItem({ branch: "main" });
      expect(resolveWorkSetup(item, HOPPER_HOME)).toEqual({ type: "cwd" });
    });

    test("worktreePath is nested under hopperHome/worktrees/<itemId>", () => {
      const item = makeItem({ workingDir: "/repo", branch: "dev" });
      const setup = resolveWorkSetup(item, "/custom/home");
      expect(setup.type).toBe("worktree");
      if (setup.type === "worktree") {
        expect(setup.worktreePath).toBe(
          "/custom/home/worktrees/abcdef12-0000-0000-0000-000000000000",
        );
      }
    });
  });

  describe("buildTaskPrompt", () => {
    test("contains item title", () => {
      const item = makeItem({ title: "Fix login bug" });
      expect(buildTaskPrompt(item)).toContain("Fix login bug");
    });

    test("contains item description", () => {
      const item = makeItem({ description: "Users cannot log in via OAuth" });
      expect(buildTaskPrompt(item)).toContain("Users cannot log in via OAuth");
    });

    test("instructs Claude not to commit and to provide a summary", () => {
      const prompt = buildTaskPrompt(makeItem());
      expect(prompt).toContain("Do NOT commit");
      expect(prompt).toContain("summary");
    });
  });

  describe("buildCommitMessage", () => {
    test("uses item title as first line", () => {
      const item = makeItem({ title: "Fix login bug" });
      const msg = buildCommitMessage(item, "Patched the OAuth flow.");
      expect(msg.split("\n")[0]).toBe("Fix login bug");
    });

    test("includes Claude summary as body after blank line", () => {
      const item = makeItem({ title: "Fix login bug" });
      const msg = buildCommitMessage(item, "Patched the OAuth flow.");
      expect(msg).toBe("Fix login bug\n\nPatched the OAuth flow.");
    });

    test("returns only title when summary is empty", () => {
      const item = makeItem({ title: "Fix login bug" });
      expect(buildCommitMessage(item, "")).toBe("Fix login bug");
      expect(buildCommitMessage(item, "  \n  ")).toBe("Fix login bug");
    });
  });

  describe("resolvePostClaudeAction", () => {
    test("shouldCommit is true when worktree exists and is dirty", () => {
      expect(resolvePostClaudeAction(true, true)).toEqual({ shouldCommit: true });
    });

    test("shouldCommit is false when worktree exists but is clean", () => {
      expect(resolvePostClaudeAction(true, false)).toEqual({ shouldCommit: false });
    });

    test("shouldCommit is false when there is no worktree, even if dirty flag is true", () => {
      expect(resolvePostClaudeAction(false, true)).toEqual({ shouldCommit: false });
    });

    test("shouldCommit is false when no worktree and clean", () => {
      expect(resolvePostClaudeAction(false, false)).toEqual({ shouldCommit: false });
    });
  });

  describe("resolveMergeAction", () => {
    test("shouldMerge is true when Claude succeeded and all context is present", () => {
      const item = makeItem({ workingDir: "/repo", branch: "main" });
      expect(resolveMergeAction(0, "hopper/abcdef12", item)).toEqual({
        shouldMerge: true,
      });
    });

    test("shouldMerge is false when Claude exited non-zero", () => {
      const item = makeItem({ workingDir: "/repo", branch: "main" });
      expect(resolveMergeAction(1, "hopper/abcdef12", item)).toEqual({
        shouldMerge: false,
      });
    });

    test("shouldMerge is false when workBranch is undefined", () => {
      const item = makeItem({ workingDir: "/repo", branch: "main" });
      expect(resolveMergeAction(0, undefined, item)).toEqual({ shouldMerge: false });
    });

    test("shouldMerge is false when item has no branch", () => {
      const item = makeItem({ workingDir: "/repo" });
      expect(resolveMergeAction(0, "hopper/abcdef12", item)).toEqual({
        shouldMerge: false,
      });
    });

    test("shouldMerge is false when item has no workingDir", () => {
      const item = makeItem({ branch: "main" });
      expect(resolveMergeAction(0, "hopper/abcdef12", item)).toEqual({
        shouldMerge: false,
      });
    });

    test("shouldMerge is false when Claude exited with any non-zero code", () => {
      const item = makeItem({ workingDir: "/repo", branch: "main" });
      expect(resolveMergeAction(2, "hopper/abcdef12", item)).toEqual({
        shouldMerge: false,
      });
    });
  });

  describe("resolveCompletionAction", () => {
    test("returns complete action when Claude succeeded", () => {
      expect(resolveCompletionAction(0, "Task done.", "")).toEqual({
        action: "complete",
        result: "Task done.",
      });
    });

    test("appends merge note to result on success", () => {
      const action = resolveCompletionAction(
        0,
        "Task done.",
        "\n\n---\nMerge: fast-forward",
      );
      expect(action.action).toBe("complete");
      expect(action.result).toBe("Task done.\n\n---\nMerge: fast-forward");
    });

    test("returns failed action when Claude exited non-zero", () => {
      expect(resolveCompletionAction(1, "(see audit log for details)", "")).toEqual({
        action: "failed",
        result: "(see audit log for details)",
      });
    });

    test("failed result still contains the claude result text", () => {
      const action = resolveCompletionAction(2, "Partial output", "");
      expect(action.action).toBe("failed");
      expect(action.result).toBe("Partial output");
    });

    test("failed result still appends merge note if present", () => {
      // Edge case: merge note was written before completion was determined
      const action = resolveCompletionAction(1, "Some output", "\n---\nNote");
      expect(action.result).toBe("Some output\n---\nNote");
    });
  });

  describe("resolveAuditPaths", () => {
    test("auditDir is <hopperHome>/audit", () => {
      const { auditDir } = resolveAuditPaths(
        "abcdef12-0000-0000-0000-000000000000",
        HOPPER_HOME,
      );
      expect(auditDir).toBe("/home/user/.hopper/audit");
    });

    test("auditFile is named <itemId>-audit.jsonl inside auditDir", () => {
      const { auditFile } = resolveAuditPaths(
        "abcdef12-0000-0000-0000-000000000000",
        HOPPER_HOME,
      );
      expect(auditFile).toBe(
        "/home/user/.hopper/audit/abcdef12-0000-0000-0000-000000000000-audit.jsonl",
      );
    });

    test("resultFile is named <itemId>-result.md inside auditDir", () => {
      const { resultFile } = resolveAuditPaths(
        "abcdef12-0000-0000-0000-000000000000",
        HOPPER_HOME,
      );
      expect(resultFile).toBe(
        "/home/user/.hopper/audit/abcdef12-0000-0000-0000-000000000000-result.md",
      );
    });

    test("uses the provided hopperHome as the root", () => {
      const { auditDir } = resolveAuditPaths("some-id", "/custom/hopper");
      expect(auditDir).toBe("/custom/hopper/audit");
    });
  });
});
