import { buildSessionPreamble, extractResult } from "../extract-result.ts";
import { type Profile, resolveProfileModel } from "../profile.ts";
import type { AgentRunner, SessionOptions } from "./agent-runner.ts";
import { mergeSpawnEnv } from "./audit-stream.ts";
import { buildClaudeArgv } from "./claude-argv.ts";
import { resolveBinOnPath } from "./resolve-bin.ts";
import { buildRunnerRunSession } from "./runner-session.ts";

const runSession = buildRunnerRunSession({
  bin: "claude",
  hint: "Ensure Claude Code is installed and available.",
  // Claude resolves agents natively via --agent in buildClaudeArgv; craftspersonBody stays null.
  resolvePrompt: (prompt, _options, _craftspersonBody) => prompt,
  resolveEnv: (options, _craftspersonBody) => mergeSpawnEnv(options.env),
  buildArgv(bin, effectivePrompt, options, _cwd, _auditFile) {
    return { argv: buildClaudeArgv(bin, effectivePrompt, options), callCtx: undefined };
  },
  buildPreamble: async (auditFile, options) => {
    const existing = options.append
      ? await Bun.file(auditFile).text().catch(() => "")
      : "";
    return buildSessionPreamble(existing, options.append ?? false);
  },
  extractOutcome: (output, exitCode, _bin, _cwd, _auditFile, _callCtx) =>
    Promise.resolve({ exitCode, result: extractResult(output) }),
});

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
