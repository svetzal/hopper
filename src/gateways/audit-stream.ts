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
