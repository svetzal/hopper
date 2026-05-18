/**
 * Runner-agnostic agent invocation interface.
 *
 * Hopper supports multiple agent runners (Claude Code and opencode). Both
 * runners implement {@link AgentRunner}; per-runner CLI specifics (argv
 * construction, output parsing, model-id translation) live in their own
 * gateway modules (`claude-gateway.ts`, `opencode-gateway.ts`).
 *
 * The legacy type names `ClaudeGateway` and `ClaudeSessionOptions` are now
 * thin aliases of {@link AgentRunner} and {@link SessionOptions} respectively,
 * preserved for backwards compatibility while callers migrate.
 */

/**
 * Options that control how an agent session is invoked.
 *
 * All fields are optional. When none are set, the runner uses its own defaults
 * (claude: stream-json, `--dangerously-skip-permissions`, no restrictions;
 * opencode: configured `opencode.json` defaults).
 *
 * Not every runner honours every field. Fields a runner does not understand
 * are silently ignored — they are recorded here so the orchestrator can
 * express its intent uniformly. See the per-runner gateway docs for the
 * actual translation behaviour.
 */
export interface SessionOptions {
  /**
   * Model tier (`"deep"`, `"balanced"`, `"fast"`) or a runner-native model ID.
   *
   * Tier names are vendor-agnostic and translate per-runner: claude maps
   * `deep|balanced|fast` to `opus|sonnet|haiku`; opencode maps them through
   * `~/.hopper/runner-config.json` to whatever provider/model the user has
   * bound. See `src/gateways/model-tier.ts`.
   */
  model?: string;
  /**
   * Agent name. For claude: passed via `--agent`, referencing a craftsperson
   * in `~/.claude/agents/`. For opencode: the craftsperson's `.md` body is
   * inlined into a transient opencode agent definition via
   * `OPENCODE_CONFIG_CONTENT`.
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
   *
   * Runner-native strings outside the unified set (e.g. claude's `xhigh`)
   * are forwarded as-is; the CLI surfaces the error if invalid.
   */
  effort?: "minimal" | "low" | "medium" | "high" | "max" | (string & {});
  /** Continue an existing audit file rather than starting fresh. */
  append?: boolean;
}

/**
 * The actual agent runner. Implementations exist for Claude Code
 * (`claude-gateway.ts`) and opencode (`opencode-gateway.ts`).
 */
export interface AgentRunner {
  /**
   * Run a full agentic session. Streams the runner's JSONL event output to
   * the audit file as it arrives, then returns the exit code and the
   * extracted final-assistant-message text as `result`.
   */
  runSession(
    prompt: string,
    cwd: string,
    auditFile: string,
    options?: SessionOptions,
  ): Promise<{ exitCode: number; result: string }>;
  /**
   * One-shot text generation with no tools and no permissions. Intended for
   * cheap deterministic calls where hopper itself needs a string (branch
   * slug, commit message, validate-marker fallback) — never for agentic work.
   *
   * In v1 the worker always calls this on a claude-backed runner regardless
   * of the user's `--runner` choice, because the Haiku one-shot path has no
   * benefit from opencode and avoids dragging the runner-config dependency
   * into branch-slug generation.
   */
  generateText(
    prompt: string,
    model: string,
    options?: { cwd?: string; appendSystemPrompt?: string },
  ): Promise<{ exitCode: number; text: string }>;
}
