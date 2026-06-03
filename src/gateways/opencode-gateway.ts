import {
  extractOpencodeResult,
  type OpencodeExport,
  parseOpencodeExport,
  resolveEffectiveExitCode,
  scanOpencodeStream,
} from "../extract-opencode-result.ts";
import type { AgentRunner, SessionOptions } from "./agent-runner.ts";
import { appendToAuditFile, formatSyntheticEvent, streamToAuditFile } from "./audit-stream.ts";
import { loadCraftspersonBody } from "./craftsperson-loader.ts";
import { buildOpencodeArgv } from "./opencode-argv.ts";
import { resolveOpencodeEnv } from "./opencode-config-content.ts";
import { resolveBinOnPath } from "./resolve-bin.ts";
import { buildGenerateText } from "./runner-generate-text.ts";

interface OpencodeRunnerDeps {
  /**
   * Override the craftsperson body loader (used in tests / for project-local
   * agent overrides). Default reads `~/.claude/agents/<name>.md`.
   */
  loadCraftsperson?: (name: string) => Promise<string | null>;
}

async function runOpencodeExport(
  opencodeBin: string,
  sessionID: string,
  cwd: string,
): Promise<OpencodeExport | null> {
  const proc = Bun.spawn([opencodeBin, "export", sessionID], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, _stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (exitCode !== 0) return null;
  return parseOpencodeExport(stdout);
}

function buildRunSession(deps: OpencodeRunnerDeps) {
  return async function runSession(
    prompt: string,
    cwd: string,
    auditFile: string,
    options: SessionOptions = {},
  ): Promise<{ exitCode: number; result: string }> {
    const opencodeBin = resolveBinOnPath("opencode", "Ensure opencode is installed and available.");

    // Build the inline agent config when a craftsperson is requested.
    // options.env (e.g. investigation PATH shims) is merged first so it forms
    // the base; resolveOpencodeEnv then overlays OPENCODE_CONFIG_CONTENT on top.
    const baseEnv: Record<string, string> = options.env
      ? { ...(process.env as Record<string, string>), ...options.env }
      : (process.env as Record<string, string>);

    let env: Record<string, string> | undefined;
    if (options.agent || options.appendSystemPrompt) {
      const loader = deps.loadCraftsperson ?? loadCraftspersonBody;
      const craftspersonBody = options.agent ? await loader(options.agent) : null;
      env = resolveOpencodeEnv(craftspersonBody, options, baseEnv);
    } else if (options.env) {
      // No craftsperson injection but caller supplied extra env vars
      env = baseEnv;
    }

    const argv = buildOpencodeArgv(opencodeBin, prompt, options, cwd);
    const proc = Bun.spawn(argv, {
      cwd,
      env,
      stdout: "pipe",
      stderr: "pipe",
    });

    const [output, stderrText] = await Promise.all([
      streamToAuditFile(proc.stdout, auditFile, ""),
      new Response(proc.stderr).text(),
    ]);

    const rawExitCode = await proc.exited;

    // Capture stderr as a JSONL event so the audit stays machine-parseable.
    if (stderrText.trim()) {
      await appendToAuditFile(
        auditFile,
        formatSyntheticEvent({ type: "stderr", text: stderrText }),
      );
    }

    const scan = scanOpencodeStream(output);

    // Fetch the canonical session document for the final-result text.
    let result = "";
    let exportDoc: OpencodeExport | null = null;
    if (scan.sessionID) {
      exportDoc = await runOpencodeExport(opencodeBin, scan.sessionID, cwd);
      if (exportDoc) {
        result = extractOpencodeResult(exportDoc);
        await appendToAuditFile(
          auditFile,
          formatSyntheticEvent({
            type: "opencode-export",
            sessionID: scan.sessionID,
            info: exportDoc.info,
          }),
        );
      }
    }

    const effectiveExitCode = resolveEffectiveExitCode(rawExitCode, scan.errors.length);

    return { exitCode: effectiveExitCode, result };
  };
}

/**
 * Construct an opencode-backed {@link AgentRunner}.
 *
 * Optional `deps` lets tests substitute a custom craftsperson loader.
 * Production callers pass nothing.
 *
 * Profile-aware: every call must include `options.profile` so model aliases
 * (`deep`/`balanced`/`fast` or user-defined aliases) resolve correctly. The
 * routing runner in `routing-runner.ts` ensures this.
 */
export function createOpencodeRunner(deps: OpencodeRunnerDeps = {}): AgentRunner {
  return {
    runSession: buildRunSession(deps),
    generateText: buildGenerateText(buildRunSession({}), "hopper-opencode-gen"),
  };
}
