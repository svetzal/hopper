import { unlink } from "node:fs/promises";
import type { AgentRunner, SessionOptions } from "./agent-runner.ts";
import { generateTempFilename, mergeSpawnEnv } from "./audit-stream.ts";
import { buildCodexArgv } from "./codex-argv.ts";
import { buildGenerateText } from "./runner-generate-text.ts";
import { buildRunnerRunSession } from "./runner-session.ts";

function buildCodexPrompt(
  prompt: string,
  options: Pick<SessionOptions, "agent" | "appendSystemPrompt">,
  craftspersonBody: string | null,
): string {
  const blocks: string[] = [];
  if (craftspersonBody) {
    blocks.push(`Use this craftsperson guidance for the task:\n\n${craftspersonBody}`);
  } else if (options.agent) {
    blocks.push(`Requested craftsperson agent: ${options.agent}`);
  }
  if (options.appendSystemPrompt) {
    blocks.push(options.appendSystemPrompt);
  }
  blocks.push(prompt);
  return blocks.join("\n\n");
}

interface CodexRunnerDeps {
  loadCraftsperson?: (name: string) => Promise<string | null>;
}

function buildRunSession(deps: CodexRunnerDeps) {
  return buildRunnerRunSession({
    bin: "codex",
    hint: "Ensure Codex CLI is installed.",
    loadCraftsperson: deps.loadCraftsperson,
    resolvePrompt: buildCodexPrompt,
    resolveEnv: (options, _craftspersonBody) => mergeSpawnEnv(options.env),
    buildArgv(bin, effectivePrompt, options, _cwd, _auditFile) {
      const resultPath = generateTempFilename("hopper-codex-result", "txt");
      return {
        argv: buildCodexArgv(bin, effectivePrompt, options, resultPath),
        callCtx: resultPath,
      };
    },
    async extractOutcome(_output, exitCode, _bin, _cwd, _auditFile, callCtx) {
      const resultPath = callCtx as string;
      const result = await Bun.file(resultPath)
        .text()
        .catch(() => "");
      await unlink(resultPath).catch(() => undefined);
      return { exitCode, result: result.trim() };
    },
  });
}

export function createCodexRunner(deps: CodexRunnerDeps = {}): AgentRunner {
  return {
    runSession: buildRunSession(deps),
    generateText: buildGenerateText(buildRunSession({}), "hopper-codex-gen"),
  };
}
