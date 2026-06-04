import { buildSessionPreamble, extractResult } from "../extract-result.ts";
import { type Profile, resolveProfileModel } from "../profile.ts";
import type { AgentRunner, SessionOptions } from "./agent-runner.ts";
import { appendToAuditFile, formatStderrEvent, streamToAuditFile } from "./audit-stream.ts";
import { buildClaudeArgv } from "./claude-argv.ts";
import { resolveBinOnPath } from "./resolve-bin.ts";

async function runSession(
  prompt: string,
  cwd: string,
  auditFile: string,
  options: SessionOptions = {},
): Promise<{ exitCode: number; result: string }> {
  const claudeBin = resolveBinOnPath("claude", "Ensure Claude Code is installed and available.");
  const argv = buildClaudeArgv(claudeBin, prompt, options);
  const spawnEnv = options.env ? { ...process.env, ...options.env } : undefined;
  const proc = Bun.spawn(argv, { cwd, env: spawnEnv, stdout: "pipe", stderr: "pipe" });

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
  await appendToAuditFile(auditFile, formatStderrEvent(stderr));

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
  const claudeBin = resolveBinOnPath("claude", "Ensure Claude Code is installed and available.");
  const argv = [
    claudeBin,
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

export function createClaudeRunner(): AgentRunner {
  return { runSession, generateText };
}
