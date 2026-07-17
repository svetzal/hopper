/**
 * Runner-agnostic agent invocation interface.
 *
 * Hopper supports multiple agent runners (Claude Code, opencode, and Codex).
 * Each runner implements {@link AgentRunner}; per-runner CLI specifics (argv
 * construction, output parsing, model-id translation) live in their own
 * gateway modules (`claude-gateway.ts`, `opencode-gateway.ts`).
 *
 * Profile selection ({@link SessionOptions.profile}) drives both *which*
 * runner handles the call and *how* model aliases resolve. See
 * `src/profile.ts` for the profile shape and `gateways/routing-runner.ts`
 * for the per-call dispatch.
 */

import type { Profile } from "../profile.ts";
import type { TerminalRunnerFailure } from "../runner-terminal-failure.ts";

/**
 * Options that control how an agent session is invoked.
 *
 * All fields are optional. When none are set, the runner uses its own defaults
 * (claude: stream-json, `--dangerously-skip-permissions`, no restrictions;
 * opencode: configured `opencode.json` defaults; codex: `exec --json` with
 * unattended approvals/sandbox bypass).
 *
 * Not every runner honours every field. Fields a runner does not understand
 * are silently ignored — they are recorded here so the orchestrator can
 * express its intent uniformly. See the per-runner gateway docs for the
 * actual translation behaviour.
 */
export interface SessionOptions {
  /**
   * Profile this session runs under. Tells the runner *which* gateway to
   * invoke (`profile.runner`) and *how* to resolve {@link model} into a
   * runner-native ID (`profile.models`).
   *
   * Required at the gateway layer. The worker resolves it from
   * `item.profile` before each call; the routing runner reads it to pick
   * claude vs opencode. Callers that construct {@link SessionOptions}
   * directly (CLI helpers, tests) must supply a profile.
   */
  profile?: Profile;
  /**
   * Model tier (`"deep"`, `"balanced"`, `"fast"`), a user-defined alias from
   * the profile's `models` map, or a runner-native provider/model ID.
   *
   * Resolution: looked up against `profile.models`; strings containing `/`
   * pass through verbatim; unmapped strings fall through to the underlying
   * runner. See `src/profile.ts:resolveProfileModel`.
   */
  model?: string;
  /**
   * Agent name. For claude: passed via `--agent`, referencing a craftsperson
   * in `~/.claude/agents/`. For opencode: the craftsperson's `.md` body is
   * inlined into a transient opencode agent definition via
   * `OPENCODE_CONFIG_CONTENT`. For codex: the craftsperson body is prepended
   * to the prompt because Codex CLI has no native craftsperson flag.
   */
  agent?: string;
  /**
   * Explicit allowlist of built-in tools. Claude: forwarded via `--tools`
   * (pass `[""]` to disable all). Opencode: not yet translated — opencode
   * has no CLI tool-allowlist flag and gates by category in its permission
   * config; this field is silently ignored in v1.
   */
  tools?: string[];
  /** Additional tool permissions. Claude: `--allowedTools`. Opencode: ignored in v1. */
  allowedTools?: string[];
  /** Denied tools. Claude: `--disallowedTools`. Opencode: ignored in v1 (worktree isolation is the blast radius). */
  disallowedTools?: string[];
  /**
   * Permission mode. Claude: `--permission-mode <mode>`; omitting it implies
   * `--dangerously-skip-permissions`. Opencode: always runs with
   * `--dangerously-skip-permissions` regardless; this field is ignored in v1.
   */
  permissionMode?: "plan" | "default" | "acceptEdits" | "bypassPermissions" | "auto" | "dontAsk";
  /**
   * Text appended to the agent's default system prompt. Claude:
   * `--append-system-prompt`. Opencode: no CLI flag exists; this is folded
   * into the inline agent config alongside the craftsperson body when an
   * agent is set.
   */
  appendSystemPrompt?: string;
  /**
   * Reasoning effort / variant. Hopper's unified vocabulary is
   * `"minimal" | "low" | "medium" | "high" | "max"`. Each runner translates:
   * - claude → `--effort <value>` (claude has no `minimal`; the claude argv
   *   builder maps `minimal` → `low`).
   * - opencode → `--variant <value>` (provider-specific; opencode passes
   *   the value through verbatim — supported levels depend on the model).
   * - codex → `--config model_reasoning_effort=<value>` (codex has no
   *   `minimal`; the codex argv builder maps `minimal` → `low`).
   *
   * Runner-native strings outside the unified set (e.g. claude's `xhigh`)
   * are forwarded as-is; the CLI surfaces the error if invalid.
   */
  effort?: "minimal" | "low" | "medium" | "high" | "max" | (string & {});
  /** Continue an existing audit file rather than starting fresh. */
  append?: boolean;
  /**
   * Extra environment variables to merge over the spawned subprocess env.
   * Used by the investigation sandbox to prepend a PATH-shim dir and capture
   * the original PATH as HOPPER_REAL_PATH. Both runners merge this over
   * process.env so HOME/TERM/LANG etc. survive.
   */
  env?: Record<string, string>;
}

export interface RunSessionOutcome {
  exitCode: number;
  result: string;
  terminalFailure?: TerminalRunnerFailure;
}

/**
 * The actual agent runner. Implementations exist for Claude Code
 * (`claude-gateway.ts`), opencode (`opencode-gateway.ts`), and Codex
 * (`codex-gateway.ts`).
 */
export interface AgentRunner {
  /**
   * Run a full agentic session. Streams the runner's JSONL event output to
   * the audit file as it arrives, then returns the exit code and the
   * extracted final-assistant-message text as `result`. Runners may also
   * attach a classified `terminalFailure` when the provider returned a
   * non-retryable account or quota condition.
   */
  runSession(
    prompt: string,
    cwd: string,
    auditFile: string,
    options?: SessionOptions,
  ): Promise<RunSessionOutcome>;
  /**
   * One-shot text generation with no tools and no permissions. Intended for
   * cheap deterministic calls where hopper itself needs a string (branch
   * slug, commit message, validate-marker fallback) — never for agentic work.
   *
   * `model` accepts the same vocabulary as {@link SessionOptions.model}:
   * tier names (`fast` typically), user aliases, or native IDs. Resolution
   * uses the supplied {@link profile} (required) — the same one the
   * surrounding session is running under.
   */
  generateText(
    prompt: string,
    model: string,
    options: {
      profile: Profile;
      cwd?: string;
      appendSystemPrompt?: string;
    },
  ): Promise<{ exitCode: number; text: string }>;
}
