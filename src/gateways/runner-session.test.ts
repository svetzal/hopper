import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SessionOptions } from "./agent-runner.ts";
import { buildRunnerRunSession, type RunnerSessionSpec } from "./runner-session.ts";

describe("buildRunnerRunSession", () => {
  let tempDir = "";

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "runner-session-test-"));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
    tempDir = "";
  });

  function makeSpec(overrides: Partial<RunnerSessionSpec> = {}): RunnerSessionSpec {
    return {
      bin: "echo",
      hint: "echo should always be available",
      resolvePrompt: (prompt) => prompt,
      resolveEnv: () => undefined,
      buildArgv: (bin, _effectivePrompt, _options, _cwd, _auditFile) => ({
        argv: [bin],
        callCtx: null,
      }),
      extractOutcome: async (_output, exitCode) => ({ exitCode, result: "" }),
      ...overrides,
    };
  }

  test("hooks are invoked in skeleton order and craftspersonBody flows from loadCraftsperson into resolvePrompt and resolveEnv", async () => {
    const calls: string[] = [];
    const captured = { promptBody: null as string | null, envBody: null as string | null };

    const spec = makeSpec({
      loadCraftsperson: async (name) => {
        calls.push("loadCraftsperson");
        return `body for ${name}`;
      },
      resolvePrompt: (prompt, _options, craftspersonBody) => {
        calls.push("resolvePrompt");
        captured.promptBody = craftspersonBody;
        return prompt;
      },
      resolveEnv: (_options, craftspersonBody) => {
        calls.push("resolveEnv");
        captured.envBody = craftspersonBody;
        return undefined;
      },
      buildArgv: (bin) => {
        calls.push("buildArgv");
        return { argv: [bin], callCtx: null };
      },
      extractOutcome: async () => {
        calls.push("extractOutcome");
        return { exitCode: 0, result: "" };
      },
    });

    const runSession = buildRunnerRunSession(spec);
    const auditFile = join(tempDir, "audit.jsonl");
    await runSession("test prompt", tempDir, auditFile, { agent: "my-agent" });

    expect(calls).toEqual([
      "loadCraftsperson",
      "resolvePrompt",
      "resolveEnv",
      "buildArgv",
      "extractOutcome",
    ]);
    expect(captured.promptBody).toBe("body for my-agent");
    expect(captured.envBody).toBe("body for my-agent");
  });

  test("resolvePrompt return value reaches buildArgv as effectivePrompt", async () => {
    let capturedEffectivePrompt = "";

    const spec = makeSpec({
      resolvePrompt: () => "EFFECTIVE_PROMPT",
      buildArgv: (bin, effectivePrompt) => {
        capturedEffectivePrompt = effectivePrompt;
        return { argv: [bin], callCtx: null };
      },
    });

    const runSession = buildRunnerRunSession(spec);
    const auditFile = join(tempDir, "audit.jsonl");
    await runSession("original prompt", tempDir, auditFile);

    expect(capturedEffectivePrompt).toBe("EFFECTIVE_PROMPT");
  });

  test("callCtx from buildArgv is passed through unchanged to extractOutcome", async () => {
    const callCtxSentinel = { id: "callCtx-sentinel" };
    let capturedCallCtx: unknown = undefined;

    const spec = makeSpec({
      buildArgv: (bin) => ({ argv: [bin], callCtx: callCtxSentinel }),
      extractOutcome: async (_output, _exitCode, _bin, _cwd, _auditFile, callCtx) => {
        capturedCallCtx = callCtx;
        return { exitCode: 0, result: "" };
      },
    });

    const runSession = buildRunnerRunSession(spec);
    const auditFile = join(tempDir, "audit.jsonl");
    await runSession("prompt", tempDir, auditFile);

    expect(capturedCallCtx).toBe(callCtxSentinel);
  });

  test("extractOutcome return value passes through as the runSession result", async () => {
    const outcomeSentinel = { exitCode: 7, result: "synthetic-result" };

    const spec = makeSpec({
      extractOutcome: async () => outcomeSentinel,
    });

    const runSession = buildRunnerRunSession(spec);
    const auditFile = join(tempDir, "audit.jsonl");
    const result = await runSession("prompt", tempDir, auditFile);

    expect(result).toBe(outcomeSentinel);
  });

  test("preamble from buildPreamble appears in audit file", async () => {
    const preamble = '{"type":"session-separator","ts":"2026-01-01"}\n';

    const spec = makeSpec({
      buildPreamble: async () => preamble,
    });

    const runSession = buildRunnerRunSession(spec);
    const auditFile = join(tempDir, "audit.jsonl");
    await runSession("prompt", tempDir, auditFile);

    const content = await readFile(auditFile, "utf8");
    expect(content).toContain("session-separator");
  });

  test("no preamble is written when buildPreamble is omitted", async () => {
    const spec = makeSpec();

    const runSession = buildRunnerRunSession(spec);
    const auditFile = join(tempDir, "audit.jsonl");
    await runSession("prompt", tempDir, auditFile);

    const content = await readFile(auditFile, "utf8").catch(() => "");
    expect(content).not.toContain("session-separator");
  });

  test("loadCraftsperson default seam: craftspersonBody is null when agent is undefined", async () => {
    const captured = { body: "UNSET" as string | null };

    const spec = makeSpec({
      resolvePrompt: (prompt, _options, craftspersonBody) => {
        captured.body = craftspersonBody;
        return prompt;
      },
    });

    const runSession = buildRunnerRunSession(spec);
    const auditFile = join(tempDir, "audit.jsonl");
    const options: SessionOptions = {};
    await runSession("prompt", tempDir, auditFile, options);

    expect(captured.body).toBeNull();
  });
});
