// Note: OpencodeGateway wraps the `opencode` CLI process and is not unit-tested
// directly, as doing so requires the opencode binary to be installed. Its core
// logic (argv construction, config-content synthesis, result extraction) is
// covered by opencode-argv.test.ts, opencode-config-content.test.ts,
// extract-opencode-result.test.ts, and runner-config.test.ts.
import { homedir } from "node:os";
import { join } from "node:path";
import { extractCraftspersonBody } from "../craftsperson-body.ts";
import {
  extractOpencodeResult,
  type OpencodeExport,
  parseOpencodeExport,
  scanOpencodeStream,
} from "../extract-opencode-result.ts";
import type { AgentRunner, SessionOptions } from "./agent-runner.ts";
import { streamToAuditFile } from "./audit-stream.ts";
import { createClaudeRunner } from "./claude-gateway.ts";
import { buildOpencodeConfigContent } from "./opencode-config-content.ts";
import { buildOpencodeArgv } from "./opencode-argv.ts";
import { loadRunnerConfig, type RunnerConfig } from "./runner-config.ts";

function resolveOpencodeBin(): string {
  const resolved = Bun.which("opencode");
  if (!resolved) {
    throw new Error(
      "opencode executable not found on PATH. Ensure opencode is installed and available.",
    );
  }
  return resolved;
}

async function loadCraftspersonBody(name: string): Promise<string | null> {
  // Mirror the same path layering as agents-gateway: global ~/.claude/agents
  // is the default; a project-local <cwd>/.claude/agents would only matter
  // if the caller explicitly passed a project dir, which the v1 opencode
  // runner does not. Keep the resolution simple.
  const path = join(homedir(), ".claude", "agents", `${name}.md`);
  const file = Bun.file(path);
  if (!(await file.exists())) return null;
  const contents = await file.text().catch(() => null);
  if (contents == null) return null;
  return extractCraftspersonBody(contents);
}

interface OpencodeRunnerDeps {
  /**
   * Override the runner-config loader. The default reads
   * `~/.hopper/runner-config.json` lazily on each call.
   */
  config?: RunnerConfig;
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

function formatSyntheticEvent(payload: Record<string, unknown>): string {
  return `${JSON.stringify(payload)}\n`;
}

function buildRunSession(deps: OpencodeRunnerDeps) {
  return async function runSession(
    prompt: string,
    cwd: string,
    auditFile: string,
    options: SessionOptions = {},
  ): Promise<{ exitCode: number; result: string }> {
    const opencodeBin = resolveOpencodeBin();
    const config = deps.config ?? (await loadRunnerConfig());

    // Build the inline agent config when a craftsperson is requested.
    let env: Record<string, string> | undefined;
    if (options.agent || options.appendSystemPrompt) {
      const loader = deps.loadCraftsperson ?? loadCraftspersonBody;
      const craftspersonBody = options.agent ? await loader(options.agent) : null;
      const configContent = buildOpencodeConfigContent({
        agentName: options.agent,
        craftspersonBody: craftspersonBody ?? undefined,
        appendSystemPrompt: options.appendSystemPrompt,
      });
      if (configContent) {
        env = { ...process.env, OPENCODE_CONFIG_CONTENT: configContent } as Record<
          string,
          string
        >;
      }
    }

    const argv = buildOpencodeArgv(opencodeBin, prompt, options, config, cwd);
    const proc = Bun.spawn(argv, {
      cwd,
      env,
      stdout: "pipe",
      stderr: "pipe",
    });

    // Optional session-separator preamble for `append` mode.
    let preamble = "";
    if (options.append) {
      const existing = await Bun.file(auditFile)
        .text()
        .catch(() => "");
      preamble = `${existing}${JSON.stringify({
        type: "session-separator",
        label: "opencode session",
      })}\n`;
    }

    const [output, stderrText] = await Promise.all([
      streamToAuditFile(proc.stdout, auditFile, preamble),
      new Response(proc.stderr).text(),
    ]);
    const rawExitCode = await proc.exited;

    // Capture stderr as a JSONL event so the audit stays machine-parseable.
    if (stderrText.trim()) {
      await Bun.write(
        auditFile,
        (await Bun.file(auditFile)
          .text()
          .catch(() => "")) +
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
        await Bun.write(
          auditFile,
          (await Bun.file(auditFile)
            .text()
            .catch(() => "")) +
            formatSyntheticEvent({
              type: "opencode-export",
              sessionID: scan.sessionID,
              info: exportDoc.info,
            }),
        );
      }
    }

    // Outcome: failure if either the process exited non-zero OR any error
    // events appeared in the stream. Exit code 0 from opencode is not a
    // reliable success signal (see docs/opencode-spike.md).
    const effectiveExitCode =
      rawExitCode !== 0
        ? rawExitCode
        : scan.errors.length > 0
          ? 1
          : 0;

    return { exitCode: effectiveExitCode, result };
  };
}

/**
 * Construct an opencode-backed {@link AgentRunner}.
 *
 * Optional `deps` lets tests / harness code substitute a fixed
 * {@link RunnerConfig} or a custom craftsperson loader. Production callers
 * pass nothing; the runner reads `~/.hopper/runner-config.json` and
 * `~/.claude/agents/<name>.md` on demand.
 *
 * Note that `generateText` is **not** implemented on the opencode runner.
 * Hopper's Haiku one-shots (branch slug, commit message, validate fallback)
 * remain on Claude Code regardless of `--runner` choice — opencode adds no
 * value to those deterministic calls and bringing it into that path would
 * couple branch-slug generation to opencode's model-mapping configuration.
 * The opencode runner delegates `generateText` straight through to the
 * claude runner.
 */
export function createOpencodeRunner(
  deps: OpencodeRunnerDeps = {},
): AgentRunner {
  const claudeRunner = createClaudeRunner();
  return {
    runSession: buildRunSession(deps),
    generateText: claudeRunner.generateText,
  };
}
