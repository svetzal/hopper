/**
 * Parses a JSONL stream from a Claude `--output-format stream-json` session
 * and returns the final result string.
 *
 * Each line is attempted as JSON. The first line whose `type` is `"result"`
 * and whose `result` field is a string is returned. Falls back to a sentinel
 * value when no result line is present (e.g. the session was interrupted).
 */
export function extractResult(jsonlOutput: string): string {
  for (const line of jsonlOutput.split("\n")) {
    try {
      const obj = JSON.parse(line) as unknown;
      if (
        typeof obj === "object" &&
        obj !== null &&
        "type" in obj &&
        (obj as Record<string, unknown>).type === "result" &&
        "result" in obj &&
        typeof (obj as Record<string, unknown>).result === "string"
      ) {
        return (obj as Record<string, unknown>).result as string;
      }
    } catch {
      // skip non-JSON lines
    }
  }
  return "(see audit log for details)";
}
