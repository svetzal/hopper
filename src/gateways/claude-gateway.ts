import { buildSessionPreamble, extractResult } from "../extract-result.ts";
import type { AgentRunner } from "./agent-runner.ts";
import { mergeSpawnEnv } from "./audit-stream.ts";
import { buildClaudeArgv } from "./claude-argv.ts";
import { buildGenerateText } from "./runner-generate-text.ts";
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
      ? await Bun.file(auditFile)
          .text()
          .catch(() => "")
      : "";
    return buildSessionPreamble(existing, options.append ?? false);
  },
  extractOutcome: (output, exitCode, _bin, _cwd, _auditFile, _callCtx) =>
    Promise.resolve({ exitCode, result: extractResult(output) }),
});

export function createClaudeRunner(): AgentRunner {
  return { runSession, generateText: buildGenerateText(runSession, "hopper-claude-gen") };
}
