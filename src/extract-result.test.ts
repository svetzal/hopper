import { describe, expect, test } from "bun:test";
import { extractResult } from "./extract-result.ts";

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
