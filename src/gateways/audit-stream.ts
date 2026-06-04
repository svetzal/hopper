import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Runner-agnostic stdout-to-audit-file streamer.
 *
 * Writing each JSONL line immediately as it arrives (rather than buffering
 * the entire output until the process exits) means coordinators can watch the
 * audit file grow in real time and detect hangs without waiting for session
 * completion. Both the claude and opencode runners emit newline-delimited
 * JSON, so this single helper handles both.
 *
 * Returns the full captured output string for callers that still need to
 * parse it after the stream ends.
 */
export function generateTempFilename(prefix: string, ext: string): string {
  return join(tmpdir(), `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`);
}

export async function streamToAuditFile(
  stdout: ReadableStream<Uint8Array>,
  auditFile: string,
  preamble: string,
): Promise<string> {
  const writer = Bun.file(auditFile).writer();
  if (preamble) {
    writer.write(preamble);
  }

  const decoder = new TextDecoder();
  let remainder = "";
  const lines: string[] = [];

  for await (const chunk of stdout) {
    const text = decoder.decode(chunk, { stream: true });
    const combined = remainder + text;
    const parts = combined.split("\n");
    remainder = parts.pop() ?? "";

    for (const line of parts) {
      const toWrite = `${line}\n`;
      writer.write(toWrite);
      await writer.flush();
      lines.push(line);
    }
  }

  if (remainder) {
    writer.write(remainder);
    await writer.flush();
    lines.push(remainder);
  }

  await writer.end();
  return lines.join("\n");
}

export function formatSyntheticEvent(payload: Record<string, unknown>): string {
  return `${JSON.stringify(payload)}\n`;
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
  if (!stderr.trim()) return "";
  return formatSyntheticEvent({ type: "stderr", text: stderr });
}

export async function appendToAuditFile(auditFile: string, event: string): Promise<void> {
  if (!event) return;
  await Bun.write(
    auditFile,
    (await Bun.file(auditFile)
      .text()
      .catch(() => "")) + event,
  );
}
