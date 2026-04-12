import { describe, expect, test } from "bun:test";
import type { Item } from "./store.ts";
import {
  buildCommitMessage,
  buildTaskPrompt,
  resolveAttemptAuditPath,
  resolveAuditPaths,
  resolveCompletionAction,
  resolveEngineeringAuditPaths,
  resolveLoopAction,
  resolveMergeAction,
  resolvePostClaimLoopAction,
  resolvePostClaudeAction,
  resolveShutdownAction,
  resolveWorkerConfig,
  resolveWorkSetup,
} from "./worker-workflow.ts";

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

    test("investigation items with workingDir run as existing-dir (never worktree)", () => {
      // Even if branch is somehow set on an investigation item, the worker
      // must not create a worktree — investigations are read-only deliverables.
      const item = makeItem({
        type: "investigation",
        workingDir: "/repo/project",
        branch: "main",
      });
      expect(resolveWorkSetup(item, HOPPER_HOME)).toEqual({
        type: "existing-dir",
        dir: "/repo/project",
      });
    });

    test("investigation items with no workingDir fall back to cwd", () => {
      const item = makeItem({ type: "investigation" });
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

    test("instructs the agent to validate work before finishing", () => {
      const prompt = buildTaskPrompt(makeItem());
      expect(prompt).toContain("validate your work");
      expect(prompt).toContain("test suite");
      expect(prompt).toContain("linter");
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
      const action = resolveCompletionAction(0, "Task done.", "\n\n---\nMerge: fast-forward");
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

  describe("resolveWorkerConfig", () => {
    test("returns defaults when no flags provided", () => {
      expect(resolveWorkerConfig({})).toEqual({
        agentName: "claude-worker",
        pollInterval: 60,
        runOnce: false,
        concurrency: 4,
      });
    });

    test("uses custom agent name from flags", () => {
      expect(resolveWorkerConfig({ agent: "my-agent" }).agentName).toBe("my-agent");
    });

    test("parses interval flag as integer", () => {
      expect(resolveWorkerConfig({ interval: "30" }).pollInterval).toBe(30);
    });

    test("sets runOnce when once flag is true", () => {
      expect(resolveWorkerConfig({ once: true }).runOnce).toBe(true);
    });

    test("parses concurrency flag as integer", () => {
      expect(resolveWorkerConfig({ concurrency: "4" }).concurrency).toBe(4);
    });

    test("ignores boolean-typed agent flag (falls back to default)", () => {
      expect(resolveWorkerConfig({ agent: true }).agentName).toBe("claude-worker");
    });

    test("ignores boolean-typed interval flag (falls back to default)", () => {
      expect(resolveWorkerConfig({ interval: true }).pollInterval).toBe(60);
    });
  });

  describe("resolveLoopAction", () => {
    test("returns wait-for-slot when all slots occupied", () => {
      expect(resolveLoopAction(3, 3, true)).toEqual({ type: "wait-for-slot" });
    });

    test("returns wait-for-slot when over concurrency", () => {
      expect(resolveLoopAction(5, 3, true)).toEqual({ type: "wait-for-slot" });
    });

    test("returns claim with free slots and shouldLog true when no active tasks", () => {
      expect(resolveLoopAction(0, 3, true)).toEqual({
        type: "claim",
        freeSlots: 3,
        shouldLog: true,
      });
    });

    test("returns claim with shouldLog false when some tasks active", () => {
      expect(resolveLoopAction(1, 3, true)).toEqual({
        type: "claim",
        freeSlots: 2,
        shouldLog: false,
      });
    });

    test("returns continue when not running", () => {
      expect(resolveLoopAction(0, 3, false)).toEqual({ type: "continue" });
    });
  });

  describe("resolvePostClaimLoopAction", () => {
    test("returns exit-no-work when nothing active, nothing claimed, and runOnce", () => {
      expect(resolvePostClaimLoopAction(0, false, true, 60)).toEqual({
        type: "exit-no-work",
        message: "No work available.",
      });
    });

    test("returns sleep when nothing active, nothing claimed, and not runOnce", () => {
      expect(resolvePostClaimLoopAction(0, false, false, 60)).toEqual({
        type: "sleep",
        message: "No work available. Waiting 60s...",
      });
    });

    test("includes custom poll interval in sleep message", () => {
      const action = resolvePostClaimLoopAction(0, false, false, 30);
      expect(action.type).toBe("sleep");
      if (action.type === "sleep") {
        expect(action.message).toContain("30s");
      }
    });

    test("returns wait-and-exit when runOnce and tasks are active", () => {
      expect(resolvePostClaimLoopAction(2, true, true, 60)).toEqual({ type: "wait-and-exit" });
    });

    test("returns wait-and-exit when runOnce with active tasks", () => {
      expect(resolvePostClaimLoopAction(1, true, true, 60)).toEqual({ type: "wait-and-exit" });
    });

    test("returns continue when not runOnce and work was claimed", () => {
      expect(resolvePostClaimLoopAction(1, true, false, 60)).toEqual({ type: "continue" });
    });

    test("returns continue when not runOnce and tasks still active even if nothing new claimed", () => {
      expect(resolvePostClaimLoopAction(2, false, false, 60)).toEqual({ type: "continue" });
    });
  });

  describe("resolveShutdownAction", () => {
    test("returns already-shutting-down when flag is true", () => {
      expect(resolveShutdownAction(true, 5)).toEqual({ type: "already-shutting-down" });
    });

    test("returns shutdown with active task count in message", () => {
      const action = resolveShutdownAction(false, 3);
      expect(action.type).toBe("shutdown");
      if (action.type === "shutdown") {
        expect(action.message).toContain("3 active task(s)");
      }
    });

    test("returns shutdown with simple message when no active tasks", () => {
      expect(resolveShutdownAction(false, 0)).toEqual({
        type: "shutdown",
        message: "\nShutting down.",
      });
    });

    test("returns shutdown message for exactly 1 active task", () => {
      const action = resolveShutdownAction(false, 1);
      expect(action.type).toBe("shutdown");
      if (action.type === "shutdown") {
        expect(action.message).toContain("1 active task(s)");
      }
    });
  });

  describe("resolveAuditPaths", () => {
    test("auditDir is <hopperHome>/audit", () => {
      const { auditDir } = resolveAuditPaths("abcdef12-0000-0000-0000-000000000000", HOPPER_HOME);
      expect(auditDir).toBe("/home/user/.hopper/audit");
    });

    test("auditFile is named <itemId>-audit.jsonl inside auditDir", () => {
      const { auditFile } = resolveAuditPaths("abcdef12-0000-0000-0000-000000000000", HOPPER_HOME);
      expect(auditFile).toBe(
        "/home/user/.hopper/audit/abcdef12-0000-0000-0000-000000000000-audit.jsonl",
      );
    });

    test("resultFile is named <itemId>-result.md inside auditDir", () => {
      const { resultFile } = resolveAuditPaths("abcdef12-0000-0000-0000-000000000000", HOPPER_HOME);
      expect(resultFile).toBe(
        "/home/user/.hopper/audit/abcdef12-0000-0000-0000-000000000000-result.md",
      );
    });

    test("uses the provided hopperHome as the root", () => {
      const { auditDir } = resolveAuditPaths("some-id", "/custom/hopper");
      expect(auditDir).toBe("/custom/hopper/audit");
    });
  });

  describe("resolveEngineeringAuditPaths", () => {
    const ID = "abcdef12-0000-0000-0000-000000000000";

    test("places all per-phase files under <hopperHome>/audit", () => {
      const paths = resolveEngineeringAuditPaths(ID, HOPPER_HOME);
      expect(paths.auditDir).toBe("/home/user/.hopper/audit");
      expect(paths.planAuditFile).toBe(`/home/user/.hopper/audit/${ID}-plan.jsonl`);
      expect(paths.executeAuditFile).toBe(`/home/user/.hopper/audit/${ID}-execute.jsonl`);
      expect(paths.validateAuditFile).toBe(`/home/user/.hopper/audit/${ID}-validate.jsonl`);
    });

    test("plan markdown lives in audit dir, never the worktree", () => {
      const { planFile, auditDir } = resolveEngineeringAuditPaths(ID, HOPPER_HOME);
      expect(planFile.startsWith(auditDir)).toBe(true);
      expect(planFile).toBe(`/home/user/.hopper/audit/${ID}-plan.md`);
    });

    test("result file is the same name the legacy task flow uses", () => {
      const { resultFile } = resolveEngineeringAuditPaths(ID, HOPPER_HOME);
      expect(resultFile).toBe(`/home/user/.hopper/audit/${ID}-result.md`);
    });

    test("respects a custom hopperHome", () => {
      const { auditDir, planFile } = resolveEngineeringAuditPaths("id", "/opt/hopper");
      expect(auditDir).toBe("/opt/hopper/audit");
      expect(planFile).toBe("/opt/hopper/audit/id-plan.md");
    });
  });

  describe("resolveAttemptAuditPath", () => {
    const ID = "abcdef12-0000-0000-0000-000000000000";

    test("attempt 1 uses the legacy name (no suffix)", () => {
      expect(resolveAttemptAuditPath(ID, HOPPER_HOME, "execute", 1)).toBe(
        `/home/user/.hopper/audit/${ID}-execute.jsonl`,
      );
      expect(resolveAttemptAuditPath(ID, HOPPER_HOME, "validate", 1)).toBe(
        `/home/user/.hopper/audit/${ID}-validate.jsonl`,
      );
    });

    test("attempt 0 also keeps the legacy name (caller treats unset as 1)", () => {
      expect(resolveAttemptAuditPath(ID, HOPPER_HOME, "execute", 0)).toBe(
        `/home/user/.hopper/audit/${ID}-execute.jsonl`,
      );
    });

    test("attempts ≥ 2 append -N to the file name", () => {
      expect(resolveAttemptAuditPath(ID, HOPPER_HOME, "execute", 2)).toBe(
        `/home/user/.hopper/audit/${ID}-execute-2.jsonl`,
      );
      expect(resolveAttemptAuditPath(ID, HOPPER_HOME, "validate", 3)).toBe(
        `/home/user/.hopper/audit/${ID}-validate-3.jsonl`,
      );
    });
  });
});
