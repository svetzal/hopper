import type { SessionOptions } from "./agent-runner.ts";
import { spawnStreamedSession } from "./audit-stream.ts";
import { resolveCraftspersonBody } from "./craftsperson-loader.ts";
import { resolveBinOnPath } from "./resolve-bin.ts";

/**
 * Per-runner hooks for the shared runSession template.
 *
 * Only the steps that genuinely differ across runners are exposed as hooks.
 * Bin resolution, craftsperson body loading, and the spawn call are fixed in
 * the skeleton returned by {@link buildRunnerRunSession}.
 *
 * `callCtx` threads an opaque per-call value from `buildArgv` into
 * `extractOutcome` so runners that need to allocate resources at argv-build
 * time (e.g. a temp result file path for Codex) can clean them up after the
 * session finishes.
 */
export interface RunnerSessionSpec {
  bin: string;
  hint: string;
  /** Override craftsperson loader (test seam / project-local agents). Default: global ~/.claude/agents. */
  loadCraftsperson?: (name: string) => Promise<string | null>;
  resolvePrompt(prompt: string, options: SessionOptions, craftspersonBody: string | null): string;
  resolveEnv(
    options: SessionOptions,
    craftspersonBody: string | null,
  ): Record<string, string | undefined> | undefined;
  buildArgv(
    bin: string,
    effectivePrompt: string,
    options: SessionOptions,
    cwd: string,
    auditFile: string,
  ): { argv: string[]; callCtx: unknown };
  buildPreamble?: (auditFile: string, options: SessionOptions) => Promise<string>;
  extractOutcome(
    output: string,
    exitCode: number,
    bin: string,
    cwd: string,
    auditFile: string,
    callCtx: unknown,
  ): Promise<{ exitCode: number; result: string }>;
}

/**
 * Build a `runSession`-shaped function from a {@link RunnerSessionSpec}.
 *
 * Shared skeleton: resolve bin → load craftsperson body → resolve prompt →
 * resolve env → build argv → optional preamble → spawn → extract outcome.
 */
export function buildRunnerRunSession(spec: RunnerSessionSpec) {
  return async function runSession(
    prompt: string,
    cwd: string,
    auditFile: string,
    options: SessionOptions = {},
  ): Promise<{ exitCode: number; result: string }> {
    const bin = resolveBinOnPath(spec.bin, spec.hint);
    const craftspersonBody = await resolveCraftspersonBody(spec.loadCraftsperson, options.agent);
    const effectivePrompt = spec.resolvePrompt(prompt, options, craftspersonBody);
    const env = spec.resolveEnv(options, craftspersonBody);
    const { argv, callCtx } = spec.buildArgv(bin, effectivePrompt, options, cwd, auditFile);
    const preamble = spec.buildPreamble ? await spec.buildPreamble(auditFile, options) : undefined;
    const { output, exitCode } = await spawnStreamedSession(argv, { cwd, env, auditFile, preamble });
    return spec.extractOutcome(output, exitCode, bin, cwd, auditFile, callCtx);
  };
}
