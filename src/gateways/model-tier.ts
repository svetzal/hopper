/**
 * Vendor-agnostic model tier vocabulary.
 *
 * Hopper's task-type workflows pin each phase to a tier (`deep`, `balanced`,
 * `fast`) rather than a vendor-specific alias. Each runner translates at
 * argv-build time:
 *
 * - **claude** maps the tier through {@link CLAUDE_TIER_MAP} to Anthropic's
 *   `opus`/`sonnet`/`haiku` aliases the `claude` CLI already understands.
 * - **opencode** maps the tier through `~/.hopper/runner-config.json`'s
 *   `opencode.models` block to a provider-native ID (e.g.
 *   `openai/gpt-5.5`, `anthropic/claude-opus-4-7`).
 *
 * Strings outside the tier vocabulary are passed through verbatim so callers
 * can still address a runner-native model directly (e.g. `model:
 * "openai/gpt-5.3-codex"`). The tier names exist for the common case where
 * hopper itself chooses based on the work being done.
 */
export type ModelTier = "deep" | "balanced" | "fast";

export const MODEL_TIERS: readonly ModelTier[] = ["deep", "balanced", "fast"] as const;

/**
 * Translation table for the claude runner. Claude's own CLI knows
 * `opus`/`sonnet`/`haiku` natively, so the mapping is hard-coded here.
 */
export const CLAUDE_TIER_MAP: Record<ModelTier, string> = {
  deep: "opus",
  balanced: "sonnet",
  fast: "haiku",
};

/**
 * Resolve a tier name (or any string) to claude's native alias.
 *
 * Tier names map through {@link CLAUDE_TIER_MAP}. Anything else (including
 * the legacy `opus`/`sonnet`/`haiku` aliases and full provider IDs) is
 * returned unchanged.
 */
export function resolveClaudeModel(alias: string): string {
  if (alias in CLAUDE_TIER_MAP) {
    return CLAUDE_TIER_MAP[alias as ModelTier];
  }
  return alias;
}

/**
 * Type guard for the tier vocabulary. Useful when the caller wants to log
 * the tier separately from any verbatim-passthrough string.
 */
export function isModelTier(value: string): value is ModelTier {
  return value === "deep" || value === "balanced" || value === "fast";
}
