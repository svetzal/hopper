import {
  extractOpencodeResult,
  type OpencodeExport,
  parseOpencodeExport,
  resolveEffectiveExitCode,
  scanOpencodeStream,
} from "../extract-opencode-result.ts";
import type { AgentRunner } from "./agent-runner.ts";
import { appendToAuditFile, formatSyntheticEvent } from "./audit-stream.ts";
import { buildOpencodeArgv } from "./opencode-argv.ts";
import { resolveOpencodeEnv } from "./opencode-config-content.ts";
import { buildGenerateText } from "./runner-generate-text.ts";
import { buildRunnerRunSession } from "./runner-session.ts";

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
  return buildRunnerRunSession({
    bin: "opencode",
    hint: "Ensure opencode is installed and available.",
    loadCraftsperson: deps.loadCraftsperson,
    resolvePrompt: (prompt, _options, _craftspersonBody) => prompt,
    resolveEnv(options, craftspersonBody) {
      // options.env (e.g. investigation PATH shims) is merged first so it forms
      // the base; resolveOpencodeEnv then overlays OPENCODE_CONFIG_CONTENT on top.
      const baseEnv: Record<string, string> = options.env
        ? { ...(process.env as Record<string, string>), ...options.env }
        : (process.env as Record<string, string>);
      if (options.agent || options.appendSystemPrompt) {
        return resolveOpencodeEnv(craftspersonBody, options, baseEnv);
      }
      if (options.env) {
        return baseEnv;
      }
      return undefined;
    },
    buildArgv(bin, effectivePrompt, options, cwd, _auditFile) {
      return {
        argv: buildOpencodeArgv(bin, effectivePrompt, options, cwd),
        callCtx: undefined,
      };
    },
    async extractOutcome(output, rawExitCode, bin, cwd, auditFile, _callCtx) {
      const scan = scanOpencodeStream(output);

      // Fetch the canonical session document for the final-result text.
      let result = "";
      if (scan.sessionID) {
        const exportDoc = await runOpencodeExport(bin, scan.sessionID, cwd);
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

      return { exitCode: resolveEffectiveExitCode(rawExitCode, scan.errors.length), result };
    },
  });
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
