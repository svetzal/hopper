import { mkdir, readdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { type Profile, type ProfileParseResult, parseProfile } from "../profile.ts";

/**
 * Filesystem layout owned by this gateway:
 *
 * ```
 * <hopperHome>/
 *   config.json            { "defaultProfile": "openai" }
 *   profiles/
 *     anthropic.json       claude runner — opus/sonnet/haiku
 *     openai.json          opencode runner — gpt-5.5/5.4/5.4-mini   (default)
 *     openrouter.json      opencode runner — glm-5.1 + others
 *     ollama.json          opencode runner — local qwen3.6
 * ```
 *
 * The bootstrap defaults reflect the 2026-06-15 Anthropic third-party cutoff:
 * `defaultProfile` is `openai` so a fresh `hopper add` works without an
 * Anthropic subscription. The `anthropic` profile is still shipped for
 * direct-API-key users.
 *
 * On first use (no `config.json`, no `profiles/`), {@link bootstrap} writes
 * all four templates and a minimal `config.json`. Existing files are never
 * overwritten — bootstrap is one-shot.
 */

export interface HopperConfig {
  defaultProfile: string;
}

export interface ProfilesGateway {
  /** Absolute path to `<hopperHome>/config.json`. */
  configPath(): string;
  /** Absolute path to the profiles directory. */
  profilesDir(): string;
  /** Absolute path to a specific profile file (does not check existence). */
  profilePath(name: string): string;
  /** List every profile name on disk (filename minus `.json`). */
  listProfileNames(): Promise<string[]>;
  /** Load and validate a profile by name. */
  loadProfile(name: string): Promise<ProfileParseResult>;
  /** Load every profile that parses cleanly; collect errors for the rest. */
  loadAllProfiles(): Promise<{
    profiles: Profile[];
    errors: Array<{ name: string; error: string }>;
  }>;
  /** Read `config.json` and return the resolved defaults. */
  loadConfig(): Promise<HopperConfig>;
  /** Persist `config.json`. */
  writeConfig(config: HopperConfig): Promise<void>;
  /** Write a profile file (creates parent dir if missing; overwrites). */
  writeProfile(name: string, body: string): Promise<void>;
  /**
   * Create `config.json` + the four shipped profile templates if either
   * `config.json` or the `profiles/` directory is missing. Idempotent — never
   * touches existing files. Returns true if anything was written.
   */
  bootstrap(): Promise<boolean>;
}

/** Default fallback when `config.json` is missing or malformed. */
export const FALLBACK_DEFAULT_PROFILE = "openai";

/**
 * Shipped profile templates. The keys are the profile names; the values are
 * pretty-printed JSON bodies suitable for writing verbatim to disk.
 */
export const SHIPPED_PROFILES: Record<string, string> = {
  anthropic: JSON.stringify(
    {
      runner: "claude",
      models: {
        deep: "opus",
        balanced: "sonnet",
        fast: "haiku",
      },
    },
    null,
    2,
  ),
  openai: JSON.stringify(
    {
      runner: "opencode",
      models: {
        deep: "openai/gpt-5.5",
        balanced: "openai/gpt-5.4",
        fast: "openai/gpt-5.4-mini",
        "gpt-5.3-codex": "openai/gpt-5.3-codex",
      },
    },
    null,
    2,
  ),
  openrouter: JSON.stringify(
    {
      runner: "opencode",
      models: {
        deep: "openrouter/z-ai/glm-5.1",
        balanced: "openrouter/anthropic/claude-sonnet-4.6",
        fast: "openrouter/google/gemini-2.5-flash",
        "glm-5.1": "openrouter/z-ai/glm-5.1",
      },
    },
    null,
    2,
  ),
  ollama: JSON.stringify(
    {
      runner: "opencode",
      models: {
        deep: "ollama/qwen3.6:27b-coding-bf16",
        balanced: "ollama/qwen3.6:27b-coding-mxfp8",
        fast: "ollama/qwen3.6:35b-a3b-coding-nvfp4",
        "qwen-bf16": "ollama/qwen3.6:27b-coding-bf16",
        "qwen-mxfp8": "ollama/qwen3.6:27b-coding-mxfp8",
        "qwen-nvfp4": "ollama/qwen3.6:35b-a3b-coding-nvfp4",
        "gpt-oss-120b": "ollama/gpt-oss:120b",
        "gpt-oss-20b": "ollama/gpt-oss:20b",
      },
    },
    null,
    2,
  ),
};

function parseConfig(raw: string): HopperConfig {
  try {
    const obj = JSON.parse(raw);
    if (obj && typeof obj === "object" && typeof obj.defaultProfile === "string") {
      return { defaultProfile: obj.defaultProfile };
    }
  } catch {
    // fall through
  }
  return { defaultProfile: FALLBACK_DEFAULT_PROFILE };
}

export function createProfilesGateway(hopperHome?: string): ProfilesGateway {
  const home = hopperHome ?? join(homedir(), ".hopper");
  const profilesDirPath = join(home, "profiles");
  const configFilePath = join(home, "config.json");

  return {
    configPath: () => configFilePath,
    profilesDir: () => profilesDirPath,
    profilePath: (name: string) => join(profilesDirPath, `${name}.json`),

    async listProfileNames(): Promise<string[]> {
      try {
        const entries = await readdir(profilesDirPath, { withFileTypes: true });
        return entries
          .filter((e) => e.isFile() && e.name.endsWith(".json"))
          .map((e) => e.name.slice(0, -".json".length))
          .sort();
      } catch {
        return [];
      }
    },

    async loadProfile(name: string): Promise<ProfileParseResult> {
      const path = join(profilesDirPath, `${name}.json`);
      const file = Bun.file(path);
      if (!(await file.exists())) {
        return { ok: false, error: `Profile not found: ${path}` };
      }
      const raw = await file.text().catch((): string => "");
      return parseProfile(name, raw);
    },

    async loadAllProfiles(): Promise<{
      profiles: Profile[];
      errors: Array<{ name: string; error: string }>;
    }> {
      const profiles: Profile[] = [];
      const errors: Array<{ name: string; error: string }> = [];
      const names = await this.listProfileNames();
      for (const name of names) {
        const result = await this.loadProfile(name);
        if (result.ok) profiles.push(result.profile);
        else errors.push({ name, error: result.error });
      }
      return { profiles, errors };
    },

    async loadConfig(): Promise<HopperConfig> {
      const file = Bun.file(configFilePath);
      if (!(await file.exists())) {
        return { defaultProfile: FALLBACK_DEFAULT_PROFILE };
      }
      const raw = await file.text().catch((): string => "");
      return parseConfig(raw);
    },

    async writeConfig(config: HopperConfig): Promise<void> {
      await mkdir(home, { recursive: true });
      await writeFile(configFilePath, `${JSON.stringify(config, null, 2)}\n`);
    },

    async writeProfile(name: string, body: string): Promise<void> {
      await mkdir(profilesDirPath, { recursive: true });
      await writeFile(join(profilesDirPath, `${name}.json`), body);
    },

    async bootstrap(): Promise<boolean> {
      const configFile = Bun.file(configFilePath);
      const configExists = await configFile.exists();

      let profilesDirExists = true;
      try {
        await readdir(profilesDirPath);
      } catch {
        profilesDirExists = false;
      }

      if (configExists && profilesDirExists) return false;

      await mkdir(profilesDirPath, { recursive: true });

      let wrote = false;

      if (!configExists) {
        await writeFile(
          configFilePath,
          `${JSON.stringify({ defaultProfile: FALLBACK_DEFAULT_PROFILE }, null, 2)}\n`,
        );
        wrote = true;
      }

      for (const [name, body] of Object.entries(SHIPPED_PROFILES)) {
        const path = join(profilesDirPath, `${name}.json`);
        const file = Bun.file(path);
        if (await file.exists()) continue;
        await writeFile(path, `${body}\n`);
        wrote = true;
      }

      return wrote;
    },
  };
}
