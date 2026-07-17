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
 * claude-runner profile; the bootstrap default profile (`config.json` →
 * `defaultProfile`) is `openai` so a clean install runs on an OpenAI-backed
 * runner without extra setup. Switch to `anthropic` any time via
 * `config.json` or `--profile anthropic`.
 */

import { toErrorMessage } from "./error-utils.ts";
import { isRecord } from "./is-record.ts";

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
export type ProfileRunner = "claude" | "opencode" | "codex";

/**
 * Reasoning effort level. Hopper's unified vocabulary; same as
 * `SessionOptions.effort` in `agent-runner.ts`. Runners translate:
 * - claude → `--effort` (maps `minimal` → `low`).
 * - opencode → `--variant`.
 * - codex → `--config model_reasoning_effort=...` (maps `minimal` → `low`).
 *
 * Profile entries may include this to lock a tier to a specific effort,
 * overriding the per-phase default chosen by the workflow.
 */
export type Effort = "minimal" | "low" | "medium" | "high" | "max";

/**
 * The bound form of a single model entry. Profile JSON accepts either a
 * bare string (model name only — phase default effort applies) or an object
 * `{ model, effort }`; both forms normalize to this shape after parsing.
 */
export interface ModelBinding {
  /** Model ID or alias to forward to the runner. */
  model: string;
  /**
   * Optional effort override for this tier. When set, overrides the
   * per-phase default effort chosen by the workflow (plan/validate=high,
   * execute=medium). Runner-native strings outside the canonical set are
   * forwarded verbatim — the runner CLI surfaces invalid-level errors.
   */
  effort?: Effort | (string & {});
}

/** The shape stored in `~/.hopper/profiles/<name>.json`, after normalization. */
export interface Profile {
  /** Filename minus `.json`. Validated at load time. */
  name: string;
  /** Which agent CLI the worker invokes for items on this profile. */
  runner: ProfileRunner;
  /**
   * Model bindings — required keys: `deep`, `balanced`, `fast`. Additional
   * keys are allowed as user-defined aliases (e.g. `qwen-bf16`,
   * `gpt-oss-large`); these are resolvable through {@link resolveProfileBinding}
   * the same way tier names are.
   *
   * On-disk each entry may be a bare model string OR an object
   * `{ "model": "...", "effort": "..." }`. Both forms normalize to
   * {@link ModelBinding} after parsing.
   */
  models: Record<string, ModelBinding>;
}

/** Outcome from parsing or loading a profile file. */
export type ProfileParseResult = { ok: true; profile: Profile } | { ok: false; error: string };

const REQUIRED_TIERS: readonly ModelTier[] = ["deep", "balanced", "fast"] as const;
const VALID_RUNNERS: ReadonlySet<string> = new Set<string>(["claude", "opencode", "codex"]);
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
  } catch (e) {
    return { ok: false, error: `Invalid JSON: ${toErrorMessage(e)}` };
  }
  if (!isRecord(parsed)) {
    return { ok: false, error: "Profile must be a JSON object" };
  }

  const runner = parsed.runner;
  if (typeof runner !== "string" || !VALID_RUNNERS.has(runner)) {
    return {
      ok: false,
      error: `Invalid 'runner' — expected "claude", "opencode", or "codex", got ${JSON.stringify(runner)}`,
    };
  }

  const modelsRaw = parsed.models;
  if (!isRecord(modelsRaw)) {
    return { ok: false, error: "'models' must be an object" };
  }
  const models: Record<string, ModelBinding> = {};
  for (const [key, value] of Object.entries(modelsRaw)) {
    if (typeof value === "string") {
      if (value.length === 0) {
        return {
          ok: false,
          error: `Model binding '${key}' must be a non-empty string, got ""`,
        };
      }
      models[key] = { model: value };
      continue;
    }
    if (isRecord(value)) {
      const m = value.model;
      if (typeof m !== "string" || m.length === 0) {
        return {
          ok: false,
          error: `Model binding '${key}.model' must be a non-empty string, got ${JSON.stringify(m)}`,
        };
      }
      const binding: ModelBinding = { model: m };
      if ("effort" in value) {
        const e = value.effort;
        if (typeof e !== "string" || e.length === 0) {
          return {
            ok: false,
            error: `Model binding '${key}.effort' must be a non-empty string, got ${JSON.stringify(e)}`,
          };
        }
        binding.effort = e as Effort;
      }
      models[key] = binding;
      continue;
    }
    return {
      ok: false,
      error: `Model binding '${key}' must be a non-empty string or an object with 'model' and optional 'effort', got ${JSON.stringify(value)}`,
    };
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
 * Resolve a model alias (tier name or user-defined alias) to its full
 * {@link ModelBinding} (model + optional effort) against a profile.
 *
 * - Strings containing `/` (provider-qualified IDs like `openai/gpt-5.5`)
 *   pass through verbatim as bare-model bindings — callers can mix tier
 *   names and native IDs in the same `SessionOptions.model` field.
 * - Mapped tier/alias names resolve via the profile's model bindings,
 *   preserving any effort override the profile carries.
 * - Unmapped strings fall through unchanged so the underlying runner gets a
 *   chance to surface "unknown model" with its own error.
 */
export function resolveProfileBinding(
  alias: string | undefined,
  profile: Profile,
): ModelBinding | undefined {
  if (!alias) return undefined;
  if (alias.includes("/")) return { model: alias };
  return profile.models[alias] ?? { model: alias };
}

/**
 * Collapse the session→{@link ModelBinding} resolution into one place.
 *
 * Three-way precedence: profile present → resolve via profile bindings;
 * model-only (no profile) → bare-model binding; neither → undefined.
 * Callers that previously duplicated this ternary in argv builders should
 * call this instead.
 */
export function resolveSessionBinding(
  model: string | undefined,
  profile: Profile | undefined,
): ModelBinding | undefined {
  return profile ? resolveProfileBinding(model, profile) : model ? { model } : undefined;
}

/**
 * Convenience wrapper that returns just the resolved model string. Effort
 * overrides from the profile are dropped — callers that care about effort
 * should use {@link resolveProfileBinding}.
 */
export function resolveProfileModel(
  alias: string | undefined,
  profile: Profile,
): string | undefined {
  return resolveProfileBinding(alias, profile)?.model;
}
