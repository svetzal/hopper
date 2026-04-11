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
  // Read concurrently to avoid pipe buffer deadlock
  const [output, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const exitCode = await proc.exited;

  if (append) {
    const existing = await Bun.file(auditFile)
      .text()
      .catch(() => "");
    const separator = `${JSON.stringify({ type: "session-separator", label: "auto-commit session" })}\n`;
    await Bun.write(auditFile, existing + separator + output + stderr);
  } else {
    await Bun.write(auditFile, output + stderr);
  }

  return { exitCode, result: extractResult(output) };
}

export function createClaudeGateway(): ClaudeGateway {
  return { runSession };
}
