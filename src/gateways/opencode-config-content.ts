/**
 * Synthesise the `OPENCODE_CONFIG_CONTENT` env var that inlines a craftsperson
 * agent definition for opencode, and decide the full environment record to
 * pass to the subprocess.
 *
 * Opencode has no CLI flag for `--append-system-prompt`, and its agent
 * definitions live in opencode-native files separate from claude craftspersons.
 * Hopper translates by inlining a transient agent definition into the
 * per-invocation config, sourced from the body of `~/.claude/agents/<name>.md`.
 */

import type { SessionOptions } from "./agent-runner.ts";

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

/**
 * Decide the environment record to pass to an opencode subprocess.
 *
 * Pure: reads no I/O. The craftsperson body must already be loaded (or null
 * if no agent was requested / the file was missing). Returns `undefined` when
 * there is nothing to inject so the caller can omit `env` entirely and let
 * opencode fall back to its `opencode.json` defaults.
 *
 * @param craftspersonBody - body extracted from `~/.claude/agents/<name>.md`,
 *   or `null` when no agent was requested or the file did not exist.
 * @param options - session options carrying `agent` and `appendSystemPrompt`.
 * @param baseEnv - base environment to extend (defaults to `process.env`).
 */
export function resolveOpencodeEnv(
  craftspersonBody: string | null,
  options: Pick<SessionOptions, "agent" | "appendSystemPrompt">,
  baseEnv: Record<string, string> = process.env as Record<string, string>,
): Record<string, string> | undefined {
  const configContent = buildOpencodeConfigContent({
    agentName: options.agent,
    craftspersonBody: craftspersonBody ?? undefined,
    appendSystemPrompt: options.appendSystemPrompt,
  });
  if (!configContent) return undefined;
  return { ...baseEnv, OPENCODE_CONFIG_CONTENT: configContent };
}
