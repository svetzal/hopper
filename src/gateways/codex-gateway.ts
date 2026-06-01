import { unlink } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { extractCraftspersonBody } from "../craftsperson-body.ts";
import type { Profile } from "../profile.ts";
import type { AgentRunner, SessionOptions } from "./agent-runner.ts";
import { streamToAuditFile } from "./audit-stream.ts";
import { buildCodexArgv } from "./codex-argv.ts";

function resolveCodexBin(): string {
  const resolved = Bun.which("codex", { PATH: process.env.PATH });
  if (!resolved) {
    throw new Error("codex executable not found on PATH. Ensure Codex CLI is installed.");
  }
  return resolved;
}

async function loadCraftspersonBody(name: string): Promise<string | null> {
  const path = join(homedir(), ".claude", "agents", `${name}.md`);
  const file = Bun.file(path);
  if (!(await file.exists())) return null;
  const contents = await file.text().catch(() => null);
  if (contents == null) return null;
  return extractCraftspersonBody(contents);
}

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

function formatSyntheticEvent(payload: Record<string, unknown>): string {
  return `${JSON.stringify(payload)}\n`;
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
    const codexBin = resolveCodexBin();
    const resultPath = join(
      tmpdir(),
      `hopper-codex-result-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.txt`,
    );

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
      await Bun.write(
        auditFile,
        (await Bun.file(auditFile)
          .text()
          .catch(() => "")) + formatSyntheticEvent({ type: "stderr", text: stderrText }),
      );
    }

    const result = await Bun.file(resultPath)
      .text()
      .catch(() => "");
    await unlink(resultPath).catch(() => undefined);
    return { exitCode, result: result.trim() };
  };
}

async function codexGenerateText(
  prompt: string,
  model: string,
  options: { profile: Profile; cwd?: string; appendSystemPrompt?: string },
): Promise<{ exitCode: number; text: string }> {
  const tmpAudit = join(
    tmpdir(),
    `hopper-codex-gen-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.jsonl`,
  );
  try {
    const runner = buildRunSession({});
    const { exitCode, result } = await runner(prompt, options.cwd ?? process.cwd(), tmpAudit, {
      model,
      profile: options.profile,
      appendSystemPrompt: options.appendSystemPrompt,
    });
    return { exitCode, text: result.trim() };
  } finally {
    await unlink(tmpAudit).catch(() => undefined);
  }
}

export function createCodexRunner(deps: CodexRunnerDeps = {}): AgentRunner {
  return {
    runSession: buildRunSession(deps),
    generateText: codexGenerateText,
  };
}
