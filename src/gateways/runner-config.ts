import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Hopper's per-user runner configuration.
 *
 * Lives at `~/.hopper/runner-config.json`. Missing or malformed → all callers
 * fall back to runner-native defaults (i.e. opencode reads its own
 * `opencode.json`, claude takes hopper's hard-coded tier translation in
 * `model-tier.ts`). The file is optional; nothing breaks without it.
 *
 * Example:
 * ```json
 * {
 *   "opencode": {
 *     "models": {
 *       "deep":     "openai/gpt-5.5",
 *       "balanced": "openai/gpt-5.4",
 *       "fast":     "openai/gpt-5.4-mini"
 *     }
 *   }
 * }
 * ```
 */
export interface RunnerConfig {
  opencode?: {
    /**
     * Map from hopper's vendor-agnostic model tier (`deep`, `balanced`,
     * `fast` — see `model-tier.ts`) to a runner-native opencode model ID.
     * Used by the opencode argv builder whenever {@link SessionOptions.model}
     * contains a tier name.
     */
    models?: Record<string, string>;
  };
}

const DEFAULT_PATH = join(homedir(), ".hopper", "runner-config.json");

/**
 * Parse a runner-config JSON string. Pure — useful for tests and for fixtures
 * that don't want to touch the filesystem. Tolerant of malformed input:
 * returns an empty config rather than throwing.
 */
export function parseRunnerConfig(raw: string): RunnerConfig {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {};
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return {};
  }
  return parsed as RunnerConfig;
}

/**
 * Load hopper's runner config from disk. Missing file → empty config.
 */
export async function loadRunnerConfig(path: string = DEFAULT_PATH): Promise<RunnerConfig> {
  const file = Bun.file(path);
  if (!(await file.exists())) return {};
  const text = await file.text().catch(() => "");
  if (!text.trim()) return {};
  return parseRunnerConfig(text);
}

/**
 * Resolve a hopper model tier (or any string) against the opencode model
 * map. If the value isn't mapped (or the map is missing), returns the value
 * unchanged so opencode itself can decide whether the string is a valid
 * model ID. Pass through any value that already looks like a provider/model
 * identifier (contains `/`) so the caller can mix tier names and native IDs
 * in the same {@link SessionOptions.model} field.
 */
export function resolveOpencodeModel(
  alias: string | undefined,
  config: RunnerConfig,
): string | undefined {
  if (!alias) return undefined;
  if (alias.includes("/")) return alias;
  return config.opencode?.models?.[alias] ?? alias;
}
