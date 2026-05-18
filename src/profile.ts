/**
 * Hopper profile — a named bundle of "which runner + which tier mapping" that
 * lives at `~/.hopper/profiles/<name>.json`. Picked per-job via `hopper add
 * --profile <name>`; baked into {@link Item.profile} at add-time so behaviour
 * stays stable across retries even if the profile file is later edited.
 *
 * Profiles replace the deprecated `~/.hopper/runner-config.json` + `--runner`
 * flag of pre-3.0 hopper. The runner choice is no longer per-worker; it
 * follows the item.
 *
 * Profile-name vocabulary: `[a-z0-9_-]+` (filename minus `.json`).
 *
 * Example profile file (`~/.hopper/profiles/ollama.json`):
 * ```json
 * {
 *   "runner": "opencode",
 *   "models": {
 *     "deep":     "ollama/qwen3.6:27b-coding-bf16",
 *     "balanced": "ollama/qwen3.6:27b-coding-mxfp8",
 *     "fast":     "ollama/qwen3.6:35b-a3b-coding-nvfp4"
 *   }
 * }
 * ```
 *
 * Profile name `anthropic` is a documentation convention for the
 * claude-runner profile; the default profile (`config.json` →
 * `defaultProfile`) is `openai` per the 2026-06-15 Anthropic third-party
 * cutoff.
 */

/**
 * Vendor-agnostic model tier vocabulary. Every profile must bind these three
 * keys; user-defined alias keys may be added alongside.
 */
export type ModelTier = "deep" | "balanced" | "fast";

export const MODEL_TIERS: readonly ModelTier[] = ["deep", "balanced", "fast"] as const;

export function isModelTier(value: string): value is ModelTier {
  return value === "deep" || value === "balanced" || value === "fast";
}

/** Which agent CLI dispatches sessions for a profile. */
export type ProfileRunner = "claude" | "opencode";

/** The shape stored in `~/.hopper/profiles/<name>.json`. */
export interface Profile {
  /** Filename minus `.json`. Validated at load time. */
  name: string;
  /** Which agent CLI the worker invokes for items on this profile. */
  runner: ProfileRunner;
  /**
   * Model bindings — required keys: `deep`, `balanced`, `fast`. Additional
   * keys are allowed as user-defined aliases (e.g. `qwen-bf16`,
   * `gpt-oss-large`); these are resolvable through {@link resolveProfileModel}
   * the same way tier names are.
   */
  models: Record<string, string>;
}

/** Outcome from parsing or loading a profile file. */
export type ProfileParseResult = { ok: true; profile: Profile } | { ok: false; error: string };

const REQUIRED_TIERS: readonly ModelTier[] = ["deep", "balanced", "fast"] as const;
const VALID_RUNNERS: ReadonlySet<string> = new Set<string>(["claude", "opencode"]);
const PROFILE_NAME_RE = /^[a-z0-9_-]+$/;

/**
 * Validate a profile name against the canonical vocabulary.
 *
 * Profile names live as filenames on disk; anything outside `[a-z0-9_-]+`
 * gets us into quoting/path-escape territory that isn't worth supporting.
 */
export function isValidProfileName(name: string): boolean {
  return PROFILE_NAME_RE.test(name);
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * Parse a profile JSON document and validate its shape. Returns a structured
 * error rather than throwing — callers surface the message with the file path
 * so the user can see where to fix it.
 *
 * Pure. Doesn't touch the filesystem.
 */
export function parseProfile(name: string, raw: string): ProfileParseResult {
  if (!isValidProfileName(name)) {
    return {
      ok: false,
      error: `Invalid profile name '${name}' — must match [a-z0-9_-]+`,
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    return { ok: false, error: `Invalid JSON: ${detail}` };
  }
  if (!isRecord(parsed)) {
    return { ok: false, error: "Profile must be a JSON object" };
  }

  const runner = parsed.runner;
  if (typeof runner !== "string" || !VALID_RUNNERS.has(runner)) {
    return {
      ok: false,
      error: `Invalid 'runner' — expected "claude" or "opencode", got ${JSON.stringify(runner)}`,
    };
  }

  const modelsRaw = parsed.models;
  if (!isRecord(modelsRaw)) {
    return { ok: false, error: "'models' must be an object" };
  }
  const models: Record<string, string> = {};
  for (const [key, value] of Object.entries(modelsRaw)) {
    if (typeof value !== "string" || value.length === 0) {
      return {
        ok: false,
        error: `Model binding '${key}' must be a non-empty string, got ${JSON.stringify(value)}`,
      };
    }
    models[key] = value;
  }

  for (const tier of REQUIRED_TIERS) {
    if (!(tier in models)) {
      return { ok: false, error: `Missing required tier '${tier}' in models` };
    }
  }

  return {
    ok: true,
    profile: {
      name,
      runner: runner as ProfileRunner,
      models,
    },
  };
}

/**
 * Resolve a model alias (tier name or user-defined alias) against a profile.
 *
 * - Strings containing `/` (provider-qualified IDs like `openai/gpt-5.5`)
 *   pass through verbatim — callers can mix tier names and native IDs in the
 *   same `SessionOptions.model` field.
 * - Mapped tier/alias names resolve via the profile's model bindings.
 * - Unmapped strings fall through unchanged so the underlying runner gets a
 *   chance to surface "unknown model" with its own error.
 */
export function resolveProfileModel(
  alias: string | undefined,
  profile: Profile,
): string | undefined {
  if (!alias) return undefined;
  if (alias.includes("/")) return alias;
  return profile.models[alias] ?? alias;
}
