import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createProfilesGateway,
  FALLBACK_DEFAULT_PROFILE,
  type ProfilesGateway,
  SHIPPED_PROFILES,
} from "./profiles-gateway.ts";

describe("createProfilesGateway", () => {
  let tempHome: string;
  let gateway: ProfilesGateway;

  beforeEach(async () => {
    tempHome = await mkdtemp(join(tmpdir(), "hopper-profile-test-"));
    gateway = createProfilesGateway(tempHome);
  });
  afterEach(async () => {
    await rm(tempHome, { recursive: true, force: true });
  });

  describe("listProfileNames", () => {
    test("returns empty array when profiles directory is missing", async () => {
      expect(await gateway.listProfileNames()).toEqual([]);
    });

    test("returns sorted list of profile names without .json suffix", async () => {
      await mkdir(join(tempHome, "profiles"), { recursive: true });
      await writeFile(join(tempHome, "profiles", "openai.json"), "{}");
      await writeFile(join(tempHome, "profiles", "ollama.json"), "{}");
      await writeFile(join(tempHome, "profiles", "anthropic.json"), "{}");

      expect(await gateway.listProfileNames()).toEqual(["anthropic", "ollama", "openai"]);
    });

    test("ignores non-.json files and subdirectories", async () => {
      const profilesDir = join(tempHome, "profiles");
      await mkdir(join(profilesDir, "subdir"), { recursive: true });
      await writeFile(join(profilesDir, "openai.json"), "{}");
      await writeFile(join(profilesDir, "README.md"), "hi");
      await writeFile(join(profilesDir, "openai.json.disabled"), "{}");

      expect(await gateway.listProfileNames()).toEqual(["openai"]);
    });
  });

  describe("loadProfile", () => {
    test("returns ok with a valid profile", async () => {
      await mkdir(join(tempHome, "profiles"), { recursive: true });
      await writeFile(
        join(tempHome, "profiles", "openai.json"),
        JSON.stringify({
          runner: "opencode",
          models: {
            deep: "openai/gpt-5.5",
            balanced: "openai/gpt-5.4",
            fast: "openai/gpt-5.4-mini",
          },
        }),
      );

      const result = await gateway.loadProfile("openai");
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.profile.runner).toBe("opencode");
        expect(result.profile.name).toBe("openai");
      }
    });

    test("returns error when profile file is missing", async () => {
      const result = await gateway.loadProfile("ghost");
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toContain("Profile not found");
    });

    test("returns parse error for malformed JSON", async () => {
      await mkdir(join(tempHome, "profiles"), { recursive: true });
      await writeFile(join(tempHome, "profiles", "broken.json"), "{ not json");

      const result = await gateway.loadProfile("broken");
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toContain("Invalid JSON");
    });
  });

  describe("loadAllProfiles", () => {
    test("returns empty arrays when no profiles exist", async () => {
      const result = await gateway.loadAllProfiles();
      expect(result.profiles).toEqual([]);
      expect(result.errors).toEqual([]);
    });

    test("separates valid profiles from those with parse errors", async () => {
      await mkdir(join(tempHome, "profiles"), { recursive: true });
      await writeFile(
        join(tempHome, "profiles", "good.json"),
        JSON.stringify({
          runner: "claude",
          models: { deep: "opus", balanced: "sonnet", fast: "haiku" },
        }),
      );
      await writeFile(join(tempHome, "profiles", "bad.json"), "{ not json");

      const result = await gateway.loadAllProfiles();
      expect(result.profiles).toHaveLength(1);
      expect(result.profiles[0]?.name).toBe("good");
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0]?.name).toBe("bad");
    });
  });

  describe("loadConfig", () => {
    test("returns fallback default when config.json is missing", async () => {
      const cfg = await gateway.loadConfig();
      expect(cfg.defaultProfile).toBe(FALLBACK_DEFAULT_PROFILE);
    });

    test("returns parsed config when file is valid", async () => {
      await writeFile(join(tempHome, "config.json"), JSON.stringify({ defaultProfile: "ollama" }));
      const cfg = await gateway.loadConfig();
      expect(cfg.defaultProfile).toBe("ollama");
    });

    test("falls back when config.json is malformed", async () => {
      await writeFile(join(tempHome, "config.json"), "garbage");
      const cfg = await gateway.loadConfig();
      expect(cfg.defaultProfile).toBe(FALLBACK_DEFAULT_PROFILE);
    });
  });

  describe("bootstrap", () => {
    test("creates config.json + all shipped profiles on empty home", async () => {
      const wrote = await gateway.bootstrap();
      expect(wrote).toBe(true);

      const cfg = await gateway.loadConfig();
      expect(cfg.defaultProfile).toBe("openai");

      const names = await gateway.listProfileNames();
      expect(names.sort()).toEqual(["anthropic", "ollama", "openai", "openrouter"]);

      for (const name of Object.keys(SHIPPED_PROFILES)) {
        const result = await gateway.loadProfile(name);
        expect(result.ok).toBe(true);
      }
    });

    test("is a no-op when config.json and profiles/ already exist", async () => {
      // First run sets everything up.
      await gateway.bootstrap();
      // Mutate one of the templates and confirm bootstrap leaves it alone.
      await writeFile(
        join(tempHome, "profiles", "openai.json"),
        JSON.stringify({ runner: "claude", models: { deep: "x", balanced: "y", fast: "z" } }),
      );

      const wrote = await gateway.bootstrap();
      expect(wrote).toBe(false);

      const result = await gateway.loadProfile("openai");
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.profile.runner).toBe("claude");
    });

    test("fills in missing files when only config.json is present", async () => {
      await writeFile(join(tempHome, "config.json"), JSON.stringify({ defaultProfile: "ollama" }));

      const wrote = await gateway.bootstrap();
      expect(wrote).toBe(true);

      const names = await gateway.listProfileNames();
      expect(names.sort()).toEqual(["anthropic", "ollama", "openai", "openrouter"]);

      // Existing config.json must not be overwritten.
      const cfg = await gateway.loadConfig();
      expect(cfg.defaultProfile).toBe("ollama");
    });

    test("doesn't overwrite existing profile files when filling in", async () => {
      await mkdir(join(tempHome, "profiles"), { recursive: true });
      await writeFile(
        join(tempHome, "profiles", "openai.json"),
        JSON.stringify({ runner: "claude", models: { deep: "x", balanced: "y", fast: "z" } }),
      );

      const wrote = await gateway.bootstrap();
      expect(wrote).toBe(true); // wrote anthropic, ollama, openrouter, config.json

      const result = await gateway.loadProfile("openai");
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.profile.runner).toBe("claude");
    });
  });

  describe("writeConfig + writeProfile", () => {
    test("writeConfig persists and is readable", async () => {
      await gateway.writeConfig({ defaultProfile: "ollama" });
      const cfg = await gateway.loadConfig();
      expect(cfg.defaultProfile).toBe("ollama");
    });

    test("writeProfile writes a file under profiles/", async () => {
      const body = JSON.stringify({
        runner: "claude",
        models: { deep: "opus", balanced: "sonnet", fast: "haiku" },
      });
      await gateway.writeProfile("custom", body);
      const result = await gateway.loadProfile("custom");
      expect(result.ok).toBe(true);
    });
  });
});
