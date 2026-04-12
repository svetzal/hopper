// Note: ClaudeGateway wraps the `claude` CLI process and is not unit-tested
// directly, as doing so requires the claude binary to be installed. Its core
// logic (JSONL result extraction) is tested via extract-result.test.ts, and
// integration behaviour is covered by worker-workflow tests.
import { extractResult } from "../extract-result.ts";

function resolveClaudeBin(): string {
  const resolved = Bun.which("claude");
  if (!resolved) {
    throw new Error(
      "claude executable not found on PATH. Ensure Claude Code is installed and available.",
    );
  }
  return resolved;
}

export interface ClaudeGateway {
  runSession(
    prompt: string,
    cwd: string,
    auditFile: string,
    options?: { append?: boolean },
  ): Promise<{ exitCode: number; result: string }>;
}

/**
 * Stream stdout from the claude subprocess to the audit file one line at a time.
 *
 * Writing each JSONL line immediately as it arrives (rather than buffering the
 * entire output until the process exits) means coordinators can watch the audit
 * file grow in real time and detect hangs without waiting for session completion.
 *
 * Returns the full output string for result extraction.
 */
async function streamToAuditFile(
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
    // The last element may be an incomplete line; hold it for the next chunk.
    remainder = parts.pop() ?? "";

    for (const line of parts) {
      const toWrite = `${line}\n`;
      writer.write(toWrite);
      await writer.flush();
      lines.push(line);
    }
  }

  // Flush any trailing bytes that arrived without a terminating newline.
  if (remainder) {
    writer.write(remainder);
    await writer.flush();
    lines.push(remainder);
  }

  await writer.end();
  return lines.join("\n");
}

async function runSession(
  prompt: string,
  cwd: string,
  auditFile: string,
  { append = false }: { append?: boolean } = {},
): Promise<{ exitCode: number; result: string }> {
  const proc = Bun.spawn(
    [
      resolveClaudeBin(),
      "--print",
      "--verbose",
      "--dangerously-skip-permissions",
      "--output-format",
      "stream-json",
      prompt,
    ],
    { cwd, stdout: "pipe", stderr: "pipe" },
  );

  let preamble = "";
  if (append) {
    const existing = await Bun.file(auditFile)
      .text()
      .catch(() => "");
    preamble = `${existing}${JSON.stringify({ type: "session-separator", label: "auto-commit session" })}\n`;
  }

  // Stream stdout to the audit file line-by-line so each event is visible on
  // disk immediately.  Stderr is drained concurrently to prevent the pipe
  // buffer from filling and blocking the subprocess.
  const [output, stderr] = await Promise.all([
    streamToAuditFile(proc.stdout, auditFile, preamble),
    new Response(proc.stderr).text(),
  ]);

  // Append stderr (usually empty) after the main JSONL stream.
  if (stderr) {
    await Bun.write(
      auditFile,
      (await Bun.file(auditFile)
        .text()
        .catch(() => "")) + stderr,
    );
  }

  const exitCode = await proc.exited;
  return { exitCode, result: extractResult(output) };
}

export function createClaudeGateway(): ClaudeGateway {
  return { runSession };
}
