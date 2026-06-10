import { describe, expect, test } from "bun:test";
import { StaleEngineeringBranchError } from "./engineering-errors.ts";
import {
  buildEngineeringFailureResult,
  buildEngineeringTranscript,
  resolveEngineeringCommitFallback,
  resolveEngineeringPreconditions,
  resolveWorktreeSetupFailureReason,
} from "./engineering-workflow.ts";

describe("resolveEngineeringPreconditions", () => {
  test("returns ok with validated values when both workingDir and branch are present", () => {
    expect(resolveEngineeringPreconditions({ workingDir: "/repo", branch: "main" })).toEqual({
      ok: true,
      workingDir: "/repo",
      branch: "main",
    });
  });

  test("returns failure when workingDir is missing", () => {
    const result = resolveEngineeringPreconditions({ branch: "main" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("--dir");
  });

  test("returns failure when branch is missing", () => {
    const result = resolveEngineeringPreconditions({ workingDir: "/repo" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("--branch");
  });

  test("returns failure when both are missing", () => {
    const result = resolveEngineeringPreconditions({});
    expect(result.ok).toBe(false);
  });
});

describe("buildEngineeringTranscript", () => {
  test("single attempt: no attempt labels", () => {
    const result = buildEngineeringTranscript("plan text", ["exec result"], ["valid result"]);
    expect(result).toContain("## Plan");
    expect(result).toContain("## Execute");
    expect(result).toContain("## Validate");
    expect(result).not.toContain("attempt");
  });

  test("multiple attempts: includes attempt labels", () => {
    const result = buildEngineeringTranscript("plan", ["exec1", "exec2"], ["val1", "val2"]);
    expect(result).toContain("## Execute (attempt 1)");
    expect(result).toContain("## Validate (attempt 1)");
    expect(result).toContain("## Execute (attempt 2)");
    expect(result).toContain("## Validate (attempt 2)");
  });

  test("empty results arrays: just plan section", () => {
    const result = buildEngineeringTranscript("plan text", [], []);
    expect(result).toBe("## Plan\n\nplan text");
  });

  test("sections appear in plan → execute → validate order", () => {
    const result = buildEngineeringTranscript("plan", ["exec"], ["valid"]);
    const planIdx = result.indexOf("## Plan");
    const execIdx = result.indexOf("## Execute");
    const validIdx = result.indexOf("## Validate");
    expect(planIdx).toBeLessThan(execIdx);
    expect(execIdx).toBeLessThan(validIdx);
  });
});

describe("buildEngineeringFailureResult", () => {
  test("appends failure message after transcript", () => {
    const result = buildEngineeringFailureResult("plan", ["exec"], ["valid"], "Failed!");
    expect(result).toContain("## Plan");
    expect(result).toContain("Failed!");
    expect(result.indexOf("## Plan")).toBeLessThan(result.indexOf("Failed!"));
  });

  test("failure message appears after all transcript content", () => {
    const result = buildEngineeringFailureResult("p", ["e"], ["v"], "FAILURE");
    expect(result.endsWith("FAILURE")).toBe(true);
  });
});

describe("resolveEngineeringCommitFallback", () => {
  const item = { title: "My task title" };

  test("returns normalised commit message when exit code is 0 and text is non-empty", () => {
    const result = resolveEngineeringCommitFallback(item, "feat: do the thing", 0);
    expect(result).toBe("feat: do the thing");
  });

  test("returns item title when exit code is non-zero", () => {
    const result = resolveEngineeringCommitFallback(item, "some text", 1);
    expect(result).toBe("My task title");
  });

  test("returns item title when text is empty after trimming", () => {
    const result = resolveEngineeringCommitFallback(item, "   ", 0);
    expect(result).toBe("My task title");
  });

  test("returns item title when text is empty string", () => {
    const result = resolveEngineeringCommitFallback(item, "", 0);
    expect(result).toBe("My task title");
  });
});

describe("resolveWorktreeSetupFailureReason", () => {
  test("StaleEngineeringBranchError with active worktrees → 'Stale branch:' prefix", () => {
    const e = new StaleEngineeringBranchError("hopper-eng/my-slug-abcd1234", ["/worktrees/id"]);
    const reason = resolveWorktreeSetupFailureReason(e);
    expect(reason).toContain("Stale branch:");
    expect(reason).toContain("hopper-eng/my-slug-abcd1234");
  });

  test("StaleEngineeringBranchError with no worktrees (diverged) → 'Stale branch:' prefix", () => {
    const e = new StaleEngineeringBranchError("hopper-eng/my-slug-abcd1234", []);
    const reason = resolveWorktreeSetupFailureReason(e);
    expect(reason).toContain("Stale branch:");
  });

  test("generic Error → 'Worktree setup failed:' prefix with message", () => {
    const e = new Error("disk full");
    const reason = resolveWorktreeSetupFailureReason(e);
    expect(reason).toContain("Worktree setup failed:");
    expect(reason).toContain("disk full");
  });

  test("non-Error thrown value → 'Worktree setup failed:' prefix", () => {
    const reason = resolveWorktreeSetupFailureReason("something went wrong");
    expect(reason).toContain("Worktree setup failed:");
    expect(reason).toContain("something went wrong");
  });
});
