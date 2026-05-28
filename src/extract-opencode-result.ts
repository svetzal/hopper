/**
 * Parse the JSONL event stream produced by `opencode run --format json` and
 * extract the canonical session result via `opencode export`.
 *
 * Opencode does not emit a terminal "result" event analogous to claude's
 * `{"type":"result", ...}` line. The stream is a sequence of incremental
 * events (`step_start`, `text`, `tool_use`, `error`, ...) and simply ends
 * when the session finishes. Hopper therefore extracts the final result via
 * the side-channel `opencode export <sessionID>` command, which returns a
 * canonical JSON document containing every message and part.
 *
 * This module is purely about parsing; the actual `opencode export`
 * invocation lives in {@link import("./gateways/opencode-gateway.ts")}.
 */

/**
 * Shape of an opencode JSONL event observed during the spike. Fields are
 * deliberately loose because the schema is undocumented and may grow.
 */
export interface OpencodeStreamEvent {
  type: string;
  timestamp?: number;
  sessionID?: string;
  error?: {
    name?: string;
    data?: { message?: string };
  };
  // Additional `part` / type-specific fields exist but aren't needed for
  // outcome decisions.
  [key: string]: unknown;
}

/**
 * Result of scanning a JSONL stream for outcome-relevant signals.
 */
export interface OpencodeStreamScan {
  /**
   * Session ID extracted from the first event that carries one. Required for
   * `opencode export`; `undefined` indicates the stream never identified a
   * session (typically because opencode failed before starting).
   */
  sessionID?: string;
  /**
   * Error events found in the stream. A non-empty array means the run failed
   * regardless of exit code.
   */
  errors: Array<{ name: string; message: string }>;
}

/**
 * Scan a captured opencode JSONL stream for session ID and error events.
 *
 * Tolerant of malformed lines: each line that fails to parse as JSON is
 * skipped (silently — the audit file already has the raw line). Trailing
 * blank lines are ignored.
 */
export function scanOpencodeStream(raw: string): OpencodeStreamScan {
  const scan: OpencodeStreamScan = { errors: [] };
  if (!raw) return scan;
  const lines = raw.split("\n");

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let event: OpencodeStreamEvent;
    try {
      event = JSON.parse(trimmed) as OpencodeStreamEvent;
    } catch {
      continue;
    }
    if (!scan.sessionID && typeof event.sessionID === "string") {
      scan.sessionID = event.sessionID;
    }
    if (event.type === "error") {
      const name = event.error?.name ?? "UnknownError";
      const message = event.error?.data?.message ?? "(no message)";
      scan.errors.push({ name, message });
    }
  }
  return scan;
}

/**
 * Shape of the JSON document returned by `opencode export <sessionID>`.
 *
 * Only the fields we read are typed; the rest is intentionally `unknown` so
 * we don't pretend to know more than the spike actually verified.
 */
export interface OpencodeExport {
  info?: {
    id?: string;
    agent?: string;
    model?: { id?: string; providerID?: string };
    cost?: number;
    tokens?: {
      input?: number;
      output?: number;
      reasoning?: number;
      cache?: { read?: number; write?: number };
    };
    summary?: { additions?: number; deletions?: number; files?: number };
  };
  messages?: Array<{
    info?: {
      role?: string;
      [key: string]: unknown;
    };
    parts?: Array<{
      type?: string;
      text?: string;
      [key: string]: unknown;
    }>;
  }>;
}

/**
 * Extract the final assistant message's concatenated text from an
 * `opencode export` JSON document. Returns an empty string when no
 * assistant message with text parts can be found — never throws.
 */
export function extractOpencodeResult(exportDoc: OpencodeExport): string {
  const messages = exportDoc.messages ?? [];
  // Walk backwards to the last assistant message that has text parts.
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg?.info?.role !== "assistant") continue;
    const textParts = (msg.parts ?? [])
      .filter((p) => p.type === "text" && typeof p.text === "string")
      .map((p) => p.text as string);
    if (textParts.length === 0) continue;
    return textParts.join("").trim();
  }
  return "";
}

/**
 * Decide the effective exit code for an opencode session.
 *
 * Opencode exit code 0 is not a reliable success signal — the process can
 * exit cleanly while error events appeared in the JSONL stream. A non-zero
 * raw exit always wins; otherwise any stream errors map to exit 1.
 *
 * See docs/opencode-spike.md for the empirical findings behind this rule.
 */
export function resolveEffectiveExitCode(rawExitCode: number, errorCount: number): number {
  if (rawExitCode !== 0) return rawExitCode;
  return errorCount > 0 ? 1 : 0;
}

/**
 * Parse a raw stdout capture of `opencode export <id>` into the typed
 * document.
 *
 * The opencode CLI prefixes the JSON with a status line (`Exporting session:
 * <id>`) — this helper strips a leading non-`{` line if present, then
 * `JSON.parse`s the remainder. Returns `null` when the output cannot be
 * parsed (so the caller can fall back to scanning the stream).
 */
export function parseOpencodeExport(raw: string): OpencodeExport | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  // Strip a leading "Exporting session: ..." status line if present.
  const jsonStart = trimmed.startsWith("{") ? trimmed : trimmed.replace(/^[^{]*\n/, "");
  try {
    return JSON.parse(jsonStart) as OpencodeExport;
  } catch {
    return null;
  }
}
