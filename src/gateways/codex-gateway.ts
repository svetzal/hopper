import { unlink } from "node:fs/promises";
import type { AgentRunner, SessionOptions } from "./agent-runner.ts";
import {
  appendToAuditFile,
  formatSyntheticEvent,
  generateTempFilename,
  streamToAuditFile,
} from "./audit-stream.ts";
import { buildCodexArgv } from "./codex-argv.ts";
import { loadCraftspersonBody } from "./craftsperson-loader.ts";
import { buildGenerateText } from "./runner-generate-text.ts";
import { resolveBinOnPath } from "./resolve-bin.ts";

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
  return async function runSession(
    prompt: string,
    cwd: string,
    auditFile: string,
    options: SessionOptions = {},
  ): Promise<{ exitCode: number; result: string }> {
    const codexBin = resolveBinOnPath("codex", "Ensure Codex CLI is installed.");
    const resultPath = generateTempFilename("hopper-codex-result", "txt");

    const loader = deps.loadCraftsperson ?? loadCraftspersonBody;
    const craftspersonBody = options.agent ? await loader(options.agent) : null;
    const effectivePrompt = buildCodexPrompt(prompt, options, craftspersonBody);
    const argv = buildCodexArgv(codexBin, effectivePrompt, options, resultPath);
    const spawnEnv = options.env ? { ...process.env, ...options.env } : undefined;
    const proc = Bun.spawn(argv, { cwd, env: spawnEnv, stdout: "pipe", stderr: "pipe" });

    const [_, stderrText] = await Promise.all([
      streamToAuditFile(proc.stdout, auditFile, ""),
      new Response(proc.stderr).text(),
    ]);
    const exitCode = await proc.exited;

    if (stderrText.trim()) {
      await appendToAuditFile(
        auditFile,
        formatSyntheticEvent({ type: "stderr", text: stderrText }),
      );
    }

    const result = await Bun.file(resultPath)
      .text()
      .catch(() => "");
    await unlink(resultPath).catch(() => undefined);
    return { exitCode, result: result.trim() };
  };
}

export function createCodexRunner(deps: CodexRunnerDeps = {}): AgentRunner {
  return {
    runSession: buildRunSession(deps),
    generateText: buildGenerateText(buildRunSession({}), "hopper-codex-gen"),
  };
}
