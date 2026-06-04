import { describe, expect, test } from "bun:test";
import { buildSessionPreamble, extractResult } from "./extract-result.ts";
import { resolveValidateOutcome } from "./task-type-workflow.ts";

describe("extractResult", () => {
  test("returns result string from a valid JSONL stream", () => {
    const jsonl = [
      JSON.stringify({ type: "start", session: "abc" }),
      JSON.stringify({ type: "assistant", text: "Working..." }),
      JSON.stringify({ type: "result", result: "Task completed successfully." }),
    ].join("\n");

    expect(extractResult(jsonl)).toBe("Task completed successfully.");
  });

  test("returns last result when multiple result lines are present", () => {
    const jsonl = [
      JSON.stringify({ type: "result", result: "First result." }),
      JSON.stringify({ type: "result", result: "Second result." }),
    ].join("\n");

    expect(extractResult(jsonl)).toBe("Second result.");
  });

  test("returns last result for multi-session validate transcript (two init/result segments)", () => {
    // Mirrors the shape of baa2a6b2-...-validate-2.jsonl:
    // Session A: claude starts, returns a background-task interim answer, emits result.
    // Session B: task_notification wakes a fresh init, agent finishes, emits VALIDATE: PASS.
    const segmentAResult =
      "Test is running in the background. I'll wait for completion notification.";
    const segmentBResult =
      "All checks passed.\n\nThe implementation is correct and all tests are green.\n\nVALIDATE: PASS";

    const jsonl = [
      JSON.stringify({ type: "system", subtype: "init", session_id: "sess-a" }),
      JSON.stringify({
        type: "assistant",
        message: { content: [{ type: "text", text: "Running playwright..." }] },
      }),
      JSON.stringify({ type: "result", subtype: "success", result: segmentAResult }),
      // Session B — task_notification resume produces a second init+result pair
      JSON.stringify({ type: "system", subtype: "init", session_id: "sess-b" }),
      JSON.stringify({
        type: "assistant",
        message: { content: [{ type: "text", text: "Tests finished." }] },
      }),
      JSON.stringify({ type: "result", subtype: "success", result: segmentBResult }),
    ].join("\n");

    const result = extractResult(jsonl);
    expect(result).toBe(segmentBResult);

    // End-to-end: resolveValidateOutcome must report PASS
    const outcome = resolveValidateOutcome(0, result);
    expect(outcome.passed).toBe(true);
  });

  test("returns single result for legacy single-session validate transcript", () => {
    const singleResult = "All checks passed.\n\nVALIDATE: PASS";

    const jsonl = [
      JSON.stringify({ type: "system", subtype: "init", session_id: "sess-x" }),
      JSON.stringify({
        type: "assistant",
        message: { content: [{ type: "text", text: "Running tests..." }] },
      }),
      JSON.stringify({ type: "result", subtype: "success", result: singleResult }),
    ].join("\n");

    const result = extractResult(jsonl);
    expect(result).toBe(singleResult);

    const outcome = resolveValidateOutcome(0, result);
    expect(outcome.passed).toBe(true);
  });

  test("returns fallback sentinel when no result line is present", () => {
    const jsonl = [
      JSON.stringify({ type: "start" }),
      JSON.stringify({ type: "assistant", text: "Thinking..." }),
    ].join("\n");

    expect(extractResult(jsonl)).toBe("(see audit log for details)");
  });

  test("returns fallback for empty string input", () => {
    expect(extractResult("")).toBe("(see audit log for details)");
  });

  test("skips non-JSON lines and still finds the result", () => {
    const jsonl = [
      "not json at all",
      JSON.stringify({ type: "assistant", text: "Hi" }),
      "another bad line {{{",
      JSON.stringify({ type: "result", result: "Done." }),
    ].join("\n");

    expect(extractResult(jsonl)).toBe("Done.");
  });

  test("skips result objects where result field is not a string", () => {
    const jsonl = [
      JSON.stringify({ type: "result", result: 42 }),
      JSON.stringify({ type: "result", result: null }),
      JSON.stringify({ type: "result", result: "Valid string result." }),
    ].join("\n");

    expect(extractResult(jsonl)).toBe("Valid string result.");
  });

  test("returns fallback when result object is missing the result field", () => {
    const jsonl = JSON.stringify({ type: "result" });

    expect(extractResult(jsonl)).toBe("(see audit log for details)");
  });

  test("handles Windows-style CRLF line endings", () => {
    const jsonl =
      JSON.stringify({ type: "start" }) +
      "\r\n" +
      JSON.stringify({ type: "result", result: "Windows result." }) +
      "\r\n";

    // split("\n") leaves "\r" on the first token — verify it still parses
    // the result line correctly since JSON.parse handles trailing \r
    expect(extractResult(jsonl)).toBe("Windows result.");
  });
});

describe("buildSessionPreamble", () => {
  test("returns empty string when append is false", () => {
    expect(buildSessionPreamble("some existing content", false)).toBe("");
    expect(buildSessionPreamble("", false)).toBe("");
  });

  test("returns existing content followed by a session-separator JSONL event when append is true", () => {
    const result = buildSessionPreamble("existing\n", true);
    expect(result.startsWith("existing\n")).toBe(true);
    const separatorLine = result.slice("existing\n".length);
    const parsed = JSON.parse(separatorLine.trimEnd());
    expect(parsed).toEqual({ type: "session-separator", label: "auto-commit session" });
    expect(result.endsWith("\n")).toBe(true);
  });

  test("works with empty existing content when append is true", () => {
    const result = buildSessionPreamble("", true);
    const parsed = JSON.parse(result.trimEnd());
    expect(parsed).toEqual({ type: "session-separator", label: "auto-commit session" });
  });
});
