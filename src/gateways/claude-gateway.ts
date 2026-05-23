// Note: ClaudeGateway wraps the `claude` CLI process and is not unit-tested
// directly, as doing so requires the claude binary to be installed. Its core
// logic (JSONL result extraction and argv construction) is tested via
// extract-result.test.ts and claude-argv.test.ts, and integration behaviour
// is covered by worker-workflow tests.
import { buildSessionPreamble, extractResult, formatStderrEvent } from "../extract-result.ts";
import { type Profile, resolveProfileModel } from "../profile.ts";
import type { AgentRunner, SessionOptions } from "./agent-runner.ts";
import { streamToAuditFile } from "./audit-stream.ts";
import { buildClaudeArgv, type ClaudeSessionOptions } from "./claude-argv.ts";

export type { ClaudeSessionOptions };

function resolveClaudeBin(): string {
  const resolved = Bun.which("claude");
  if (!resolved) {
    throw new Error(
      "claude executable not found on PATH. Ensure Claude Code is installed and available.",
    );
  }
  return resolved;
}

/**
 * Legacy alias for the runner-agnostic {@link AgentRunner}. Kept so existing
 * imports keep compiling; new code should import `AgentRunner` directly from
 * `./agent-runner.ts`.
 */
export type ClaudeGateway = AgentRunner;

async function runSession(
  prompt: string,
  cwd: string,
  auditFile: string,
  options: SessionOptions = {},
): Promise<{ exitCode: number; result: string }> {
  const argv = buildClaudeArgv(resolveClaudeBin(), prompt, options);
  const proc = Bun.spawn(argv, { cwd, stdout: "pipe", stderr: "pipe" });

  const existing = options.append
    ? await Bun.file(auditFile)
        .text()
        .catch(() => "")
    : "";
  const preamble = buildSessionPreamble(existing, options.append ?? false);

  // Stream stdout to the audit file line-by-line so each event is visible on
  // disk immediately.  Stderr is drained concurrently to prevent the pipe
  // buffer from filling and blocking the subprocess.
  const [output, stderr] = await Promise.all([
    streamToAuditFile(proc.stdout, auditFile, preamble),
    new Response(proc.stderr).text(),
  ]);

  // Wrap stderr (usually empty) as a single JSONL-valid event line so the
  // audit file stays machine-parseable. The raw-append behaviour we had
  // before produced bare error strings at the tail that broke line-by-line
  // consumers.
  const stderrEvent = formatStderrEvent(stderr);
  if (stderrEvent) {
    await Bun.write(
      auditFile,
      (await Bun.file(auditFile)
        .text()
        .catch(() => "")) + stderrEvent,
    );
  }

  const exitCode = await proc.exited;
  return { exitCode, result: extractResult(output) };
}

async function generateText(
  prompt: string,
  model: string,
  options: { profile: Profile; cwd?: string; appendSystemPrompt?: string },
): Promise<{ exitCode: number; text: string }> {
  // Plain text output, no tools, no permissions. Just a model speaking to itself.
  // Note: the prompt goes after `--` so Commander's variadic `--tools` handler
  // on the claude side cannot siphon it into its value list. (See
  // src/gateways/claude-argv.ts for the same reasoning applied to runSession.)
  const resolvedModel = resolveProfileModel(model, options.profile) ?? model;
  const argv = [
    resolveClaudeBin(),
    "--print",
    "--dangerously-skip-permissions",
    "--model",
    resolvedModel,
    "--tools",
    "",
  ];
  if (options.appendSystemPrompt) {
    argv.push("--append-system-prompt", options.appendSystemPrompt);
  }
  argv.push("--", prompt);

  const proc = Bun.spawn(argv, {
    cwd: options.cwd ?? process.cwd(),
    stdout: "pipe",
    stderr: "pipe",
  });

  const [stdout, _stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);

  const exitCode = await proc.exited;
  return { exitCode, text: stdout.trim() };
}

export function createClaudeGateway(): ClaudeGateway {
  return { runSession, generateText };
}

/**
 * Preferred alias of {@link createClaudeGateway} that emphasises the
 * runner-agnostic interface. Use this in new call sites; `createClaudeGateway`
 * stays around for existing imports.
 */
export const createClaudeRunner: () => AgentRunner = createClaudeGateway;
