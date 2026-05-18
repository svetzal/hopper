/**
 * Build the JSON value that goes into the `OPENCODE_CONFIG_CONTENT`
 * environment variable for a hopper-dispatched opencode session.
 *
 * Opencode has no CLI flag for `--append-system-prompt`, and its agent
 * definitions live in opencode-native files separate from claude
 * craftspersons. Hopper translates by inlining a transient agent definition
 * into the per-invocation config, sourced from the body of
 * `~/.claude/agents/<name>.md`.
 *
 * The returned value is a JSON string suitable for
 * `Bun.spawn({ env: { OPENCODE_CONFIG_CONTENT: value, ... } })`. When neither
 * a craftsperson body nor an appendSystemPrompt is provided, returns `null`
 * — callers should omit the env var entirely in that case so opencode falls
 * back to the user's `opencode.json` defaults.
 */

export interface OpencodeAgentInjection {
  /**
   * The craftsperson's logical name (e.g. `rust-craftsperson`). Used as the
   * agent key in the synthesised config.
   */
  agentName?: string;
  /**
   * The craftsperson's system-prompt body (everything after the YAML
   * frontmatter in the `.md` file). When null, no craftsperson is being
   * injected.
   */
  craftspersonBody?: string;
  /**
   * Optional extra system-prompt text appended after the craftsperson body.
   * Mirrors claude's `--append-system-prompt`.
   */
  appendSystemPrompt?: string;
}

/**
 * Returns the JSON string for `OPENCODE_CONFIG_CONTENT`, or `null` when
 * there's nothing to inject.
 *
 * Pure — no I/O. The craftsperson body should already have been loaded by
 * the caller (see {@link import("../craftsperson-body.ts").extractCraftspersonBody}).
 */
export function buildOpencodeConfigContent(injection: OpencodeAgentInjection): string | null {
  const systemPromptParts: string[] = [];
  if (injection.craftspersonBody?.trim()) {
    systemPromptParts.push(injection.craftspersonBody.trim());
  }
  if (injection.appendSystemPrompt?.trim()) {
    systemPromptParts.push(injection.appendSystemPrompt.trim());
  }
  if (systemPromptParts.length === 0) return null;

  const prompt = systemPromptParts.join("\n\n");
  const agentKey = injection.agentName?.trim() || "hopper-injected";

  const config = {
    $schema: "https://opencode.ai/config.json",
    agent: {
      [agentKey]: {
        description: `Hopper-injected craftsperson: ${agentKey}`,
        prompt,
        mode: "primary",
      },
    },
  };
  return JSON.stringify(config);
}
