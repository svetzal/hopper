import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createProfilesGateway, type ProfilesGateway } from "../gateways/profiles-gateway.ts";
import { makeParsed } from "../test-helpers.ts";
import { profilesCommand } from "./profiles.ts";

describe("profilesCommand", () => {
  let tempHome: string;
  let gateway: ProfilesGateway;

  beforeEach(async () => {
    tempHome = await mkdtemp(join(tmpdir(), "hopper-profiles-cmd-"));
    gateway = createProfilesGateway(tempHome);
  });
  afterEach(async () => {
    await rm(tempHome, { recursive: true, force: true });
  });

  test("lists shipped profiles after bootstrap with default flagged", async () => {
    const result = await profilesCommand(makeParsed("profiles", []), gateway);
    expect(result.status).toBe("success");
    if (result.status === "success" && typeof result.data === "object") {
      expect(result.data.defaultProfile).toBe("openai");
      const names = result.data.profiles.map((p) => p.name).sort();
      expect(names).toEqual(["anthropic", "codex", "ollama", "openai", "openrouter"]);
      // openai is starred in humanOutput
      expect(result.humanOutput).toContain("* openai");
    }
  });

  test("lists no profiles when bootstrap is suppressed and dir is empty", async () => {
    // Bypass the bootstrap by stubbing it. listProfileNames returns empty.
    const stubGateway: ProfilesGateway = {
      ...gateway,
      bootstrap: async () => false,
      listProfileNames: async () => [],
      loadAllProfiles: async () => ({ profiles: [], errors: [] }),
      loadConfig: async () => ({ defaultProfile: "openai" }),
    };
    const result = await profilesCommand(makeParsed("profiles", []), stubGateway);
    expect(result.status).toBe("success");
    if (result.status === "success") {
      expect(result.humanOutput).toContain("no profiles found");
    }
  });

  test("reports parse errors for broken profile files", async () => {
    await gateway.bootstrap();
    await writeFile(join(tempHome, "profiles", "broken.json"), "{ not json");
    const result = await profilesCommand(makeParsed("profiles", []), gateway);
    expect(result.status).toBe("success");
    if (result.status === "success" && typeof result.data === "object") {
      expect(result.data.errors).toHaveLength(1);
      expect(result.data.errors[0]?.name).toBe("broken");
      expect(result.humanOutput).toContain("broken:");
    }
  });

  test("'show <name>' prints the profile contents", async () => {
    await gateway.bootstrap();
    const result = await profilesCommand(makeParsed("profiles", ["show", "ollama"]), gateway);
    expect(result.status).toBe("success");
    if (result.status === "success") {
      expect(result.humanOutput).toContain("ollama/qwen3.6:27b-coding-bf16");
      expect(result.humanOutput).toContain('"runner": "opencode"');
    }
  });

  test("'show' without a name returns usage error", async () => {
    const result = await profilesCommand(makeParsed("profiles", ["show"]), gateway);
    expect(result.status).toBe("error");
    if (result.status === "error") expect(result.message).toContain("Usage:");
  });

  test("'show <missing>' returns a not-found error", async () => {
    await gateway.bootstrap();
    const result = await profilesCommand(makeParsed("profiles", ["show", "ghost"]), gateway);
    expect(result.status).toBe("error");
    if (result.status === "error") expect(result.message).toContain("Profile not found");
  });

  test("unknown subcommand is rejected", async () => {
    const result = await profilesCommand(makeParsed("profiles", ["delete"]), gateway);
    expect(result.status).toBe("error");
    if (result.status === "error") expect(result.message).toContain("Unknown subcommand");
  });
});
