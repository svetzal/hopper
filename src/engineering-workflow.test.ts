import { describe, expect, test } from "bun:test";
import {
  buildEngineeringFailureResult,
  buildEngineeringTranscript,
  resolveEngineeringCommitFallback,
} from "./engineering-workflow.ts";

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
