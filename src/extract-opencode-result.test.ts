import { describe, expect, test } from "bun:test";
import {
  extractOpencodeResult,
  parseOpencodeExport,
  resolveEffectiveExitCode,
  scanOpencodeStream,
} from "./extract-opencode-result.ts";

describe("scanOpencodeStream", () => {
  test("extracts session ID from the first event that carries one", () => {
    const stream = [
      JSON.stringify({
        type: "step_start",
        timestamp: 1,
        sessionID: "ses_abc",
        part: {},
      }),
      JSON.stringify({
        type: "text",
        timestamp: 2,
        sessionID: "ses_abc",
        part: { type: "text", text: "PONG" },
      }),
    ].join("\n");
    const scan = scanOpencodeStream(stream);
    expect(scan.sessionID).toBe("ses_abc");
    expect(scan.errors).toEqual([]);
  });

  test("collects error events even when stream ends cleanly", () => {
    const stream = [
      JSON.stringify({
        type: "step_start",
        timestamp: 1,
        sessionID: "ses_err",
      }),
      JSON.stringify({
        type: "error",
        timestamp: 2,
        sessionID: "ses_err",
        error: { name: "APIError", data: { message: "model not found" } },
      }),
    ].join("\n");
    const scan = scanOpencodeStream(stream);
    expect(scan.sessionID).toBe("ses_err");
    expect(scan.errors).toHaveLength(1);
    expect(scan.errors[0]).toEqual({
      name: "APIError",
      message: "model not found",
    });
  });

  test("tolerates malformed lines without throwing", () => {
    const stream = [
      "not-json",
      JSON.stringify({ type: "step_start", sessionID: "ses_ok" }),
      "{not json either",
    ].join("\n");
    const scan = scanOpencodeStream(stream);
    expect(scan.sessionID).toBe("ses_ok");
    expect(scan.errors).toEqual([]);
  });

  test("returns an empty scan for empty input", () => {
    const scan = scanOpencodeStream("");
    expect(scan.sessionID).toBeUndefined();
    expect(scan.errors).toEqual([]);
  });

  test("falls back to UnknownError + (no message) when error event is malformed", () => {
    const stream = JSON.stringify({ type: "error", sessionID: "s" });
    const scan = scanOpencodeStream(stream);
    expect(scan.errors[0]).toEqual({
      name: "UnknownError",
      message: "(no message)",
    });
  });

  test("skips JSONL lines that are valid JSON but not objects (array, number, string)", () => {
    const stream = [
      JSON.stringify([1, 2, 3]),
      "42",
      '"just a string"',
      JSON.stringify({ type: "step_start", sessionID: "ses_real" }),
    ].join("\n");
    const scan = scanOpencodeStream(stream);
    expect(scan.sessionID).toBe("ses_real");
    expect(scan.errors).toEqual([]);
  });
});

describe("resolveEffectiveExitCode", () => {
  test("returns non-zero raw exit code unchanged regardless of error count", () => {
    expect(resolveEffectiveExitCode(1, 0)).toBe(1);
    expect(resolveEffectiveExitCode(2, 0)).toBe(2);
    expect(resolveEffectiveExitCode(1, 3)).toBe(1);
  });

  test("returns 1 when raw exit is 0 but stream errors were found", () => {
    expect(resolveEffectiveExitCode(0, 1)).toBe(1);
    expect(resolveEffectiveExitCode(0, 3)).toBe(1);
  });

  test("returns 0 when raw exit is 0 and no stream errors", () => {
    expect(resolveEffectiveExitCode(0, 0)).toBe(0);
  });
});

describe("parseOpencodeExport", () => {
  test("parses JSON without status prefix", () => {
    const doc = parseOpencodeExport(JSON.stringify({ info: { id: "ses_x" } }));
    expect(doc?.info?.id).toBe("ses_x");
  });

  test("strips a leading non-JSON status line", () => {
    const raw = `Exporting session: ses_x\n${JSON.stringify({
      info: { id: "ses_x" },
    })}`;
    const doc = parseOpencodeExport(raw);
    expect(doc?.info?.id).toBe("ses_x");
  });

  test("returns null for unparseable input", () => {
    expect(parseOpencodeExport("")).toBeNull();
    expect(parseOpencodeExport("not json at all")).toBeNull();
    expect(parseOpencodeExport("Exporting session: ses_x\nnot-json")).toBeNull();
  });

  test("returns null when top-level parsed value is a JSON array", () => {
    expect(parseOpencodeExport(JSON.stringify([1, 2, 3]))).toBeNull();
  });

  test("returns null when top-level parsed value is a JSON string", () => {
    expect(parseOpencodeExport(JSON.stringify("just a string"))).toBeNull();
  });
});

describe("extractOpencodeResult", () => {
  test("returns the concatenated text parts of the last assistant message", () => {
    const result = extractOpencodeResult({
      messages: [
        { info: { role: "user" }, parts: [{ type: "text", text: "say PONG" }] },
        {
          info: { role: "assistant" },
          parts: [
            { type: "text", text: "PONG" },
            { type: "text", text: " — out" },
          ],
        },
      ],
    });
    expect(result).toBe("PONG — out");
  });

  test("walks back past assistant messages with no text parts", () => {
    const result = extractOpencodeResult({
      messages: [
        { info: { role: "user" }, parts: [{ type: "text", text: "hi" }] },
        {
          info: { role: "assistant" },
          parts: [{ type: "text", text: "real reply" }],
        },
        // a later assistant message exists but has only tool parts.
        {
          info: { role: "assistant" },
          parts: [{ type: "tool_use", text: undefined }],
        },
      ],
    });
    expect(result).toBe("real reply");
  });

  test("returns empty string when no assistant message has text", () => {
    expect(extractOpencodeResult({ messages: [] })).toBe("");
    expect(
      extractOpencodeResult({
        messages: [{ info: { role: "user" }, parts: [{ type: "text", text: "hi" }] }],
      }),
    ).toBe("");
  });

  test("returns empty string on a malformed export with no messages", () => {
    expect(extractOpencodeResult({})).toBe("");
  });

  test("trims surrounding whitespace from the concatenated result", () => {
    const result = extractOpencodeResult({
      messages: [
        {
          info: { role: "assistant" },
          parts: [{ type: "text", text: "  PONG  " }],
        },
      ],
    });
    expect(result).toBe("PONG");
  });
});
