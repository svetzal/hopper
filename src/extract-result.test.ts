import { describe, expect, test } from "bun:test";
import { extractResult, formatStderrEvent } from "./extract-result.ts";

describe("extractResult", () => {
  test("returns result string from a valid JSONL stream", () => {
    const jsonl = [
      JSON.stringify({ type: "start", session: "abc" }),
      JSON.stringify({ type: "assistant", text: "Working..." }),
      JSON.stringify({ type: "result", result: "Task completed successfully." }),
    ].join("\n");

    expect(extractResult(jsonl)).toBe("Task completed successfully.");
  });

  test("returns first result when multiple result lines are present", () => {
    const jsonl = [
      JSON.stringify({ type: "result", result: "First result." }),
      JSON.stringify({ type: "result", result: "Second result." }),
    ].join("\n");

    expect(extractResult(jsonl)).toBe("First result.");
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

describe("formatStderrEvent", () => {
  test("returns empty string when stderr is empty", () => {
    expect(formatStderrEvent("")).toBe("");
  });

  test("wraps a single-line stderr as a JSONL event with trailing newline", () => {
    const line = formatStderrEvent("Error: Input must be provided");
    expect(line.endsWith("\n")).toBe(true);
    const parsed = JSON.parse(line.trimEnd());
    expect(parsed).toEqual({ type: "stderr", text: "Error: Input must be provided" });
  });

  test("keeps multi-line stderr as a single JSONL object (escaped newlines)", () => {
    const raw = 'Traceback (most recent call last):\n  File "x.py", line 1\nBoom\n';
    const line = formatStderrEvent(raw);
    // Exactly one JSONL row — no embedded unescaped newlines breaking the format
    const rows = line.trimEnd().split("\n");
    expect(rows).toHaveLength(1);
    const parsed = JSON.parse(rows[0] as string);
    expect(parsed.type).toBe("stderr");
    expect(parsed.text).toBe(raw);
  });

  test("escapes quotes and control characters correctly so parsers don't choke", () => {
    const raw = 'oops: "quoted" thing\ttab\x00nul';
    const line = formatStderrEvent(raw);
    const parsed = JSON.parse(line.trimEnd());
    expect(parsed.text).toBe(raw);
  });
});
