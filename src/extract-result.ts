/**
 * Parses a JSONL stream from a Claude `--output-format stream-json` session
 * and returns the final result string.
 *
 * Each line is attempted as JSON. The **last** line whose `type` is `"result"`
 * and whose `result` field is a string is returned. Using the last match
 * handles multi-session transcripts — for example when a long-running Bash
 * command causes Claude Code to emit a `task_notification` resume, producing
 * two `init`/`result` segment pairs in the same audit log. The agent's actual
 * final answer (including any `VALIDATE: PASS` marker) lives in the last
 * segment. For single-segment sessions there is only one `result` line, so
 * behaviour is unchanged.
 *
 * Falls back to a sentinel value when no result line is present (e.g. the
 * session was interrupted).
 */
export function extractResult(jsonlOutput: string): string {
  let lastResult: string | undefined;
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
        lastResult = (obj as Record<string, unknown>).result as string;
      }
    } catch {
      // skip non-JSON lines
    }
  }
  return lastResult ?? "(see audit log for details)";
}

/**
 * Build the preamble written before a new append-mode session starts.
 *
 * When `append` is true, returns `existingContent` + a session-separator
 * JSONL event so the two sessions are delimited in the same audit file.
 * When `append` is false, returns an empty string (fresh file; no preamble).
 */
export function buildSessionPreamble(existingContent: string, append: boolean): string {
  if (!append) return "";
  return `${existingContent}${JSON.stringify({ type: "session-separator", label: "auto-commit session" })}\n`;
}

/**
 * Wrap captured stderr as a single JSONL-valid event line so line-by-line
 * parsers can still read the audit file without tripping over a bare error
 * message at the tail. Returns an empty string when there's nothing to emit,
 * so callers can safely concatenate.
 *
 * The emitted line is a JSON.stringify object with `type: "stderr"` and a
 * `text` field holding the full stderr verbatim (newlines escaped), plus a
 * trailing newline so it sits as its own JSONL row. Multi-line stderr stays
 * in one event rather than being split into many — stack traces are easier
 * to read as a single block.
 */
export function formatStderrEvent(stderr: string): string {
  if (!stderr) return "";
  return `${JSON.stringify({ type: "stderr", text: stderr })}\n`;
}
