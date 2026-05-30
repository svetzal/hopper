import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import type { ProfilesGateway } from "../gateways/profiles-gateway.ts";
import { addItem } from "../store.ts";
import { makeItem, makeParsed, setupTempStoreDir } from "../test-helpers.ts";
import type { TitleGenerator } from "../titler.ts";
import { addCommand } from "./add.ts";

function makeTitler(title = "Generated Title"): TitleGenerator {
  return { generateTitle: mock(async (_desc: string) => title) };
}

function makeStubProfilesGateway(): ProfilesGateway {
  return {
    configPath: () => "/tmp/config.json",
    profilesDir: () => "/tmp/profiles",
    profilePath: (n) => `/tmp/profiles/${n}.json`,
    listProfileNames: async () => ["test"],
    loadProfile: async (n) => ({
      ok: true,
      profile: {
        name: n,
        runner: "claude",
        models: {
          deep: { model: "opus" },
          balanced: { model: "sonnet" },
          fast: { model: "haiku" },
        },
      },
    }),
    loadAllProfiles: async () => ({ profiles: [], errors: [] }),
    loadConfig: async () => ({ defaultProfile: "test" }),
    writeConfig: async () => {},
    writeProfile: async () => {},
    bootstrap: async () => false,
  };
}

describe("addCommand", () => {
  const storeDir = setupTempStoreDir("hopper-add-test-");

  beforeEach(storeDir.beforeEach);
  afterEach(storeDir.afterEach);

  test("returns error when no description is provided", async () => {
    const result = await addCommand(
      makeParsed("add", []),
      makeTitler(),
      makeStubProfilesGateway(),
      async () => "",
    );

    expect(result.status).toBe("error");
    if (result.status === "error") {
      expect(result.message).toBeTruthy();
    }
  });

  test("returns success with added item", async () => {
    const result = await addCommand(
      makeParsed("add", ["Fix the login bug"]),
      makeTitler(),
      makeStubProfilesGateway(),
    );

    expect(result.status).toBe("success");
    if (result.status === "success") {
      expect(result.humanOutput).toContain("Added:");
    }
  });

  test("uses generated title in humanOutput", async () => {
    const result = await addCommand(
      makeParsed("add", ["Fix the login bug"]),
      makeTitler("Fix Login Bug"),
      makeStubProfilesGateway(),
    );

    expect(result.status).toBe("success");
    if (result.status === "success") {
      expect(result.humanOutput).toContain("Fix Login Bug");
    }
  });

  test("returns error for invalid priority", async () => {
    const result = await addCommand(
      makeParsed("add", ["A task"], { priority: "critical" }),
      makeTitler(),
      makeStubProfilesGateway(),
    );

    expect(result.status).toBe("error");
  });

  test("returns error when --dir is set without --branch or --command", async () => {
    const result = await addCommand(
      makeParsed("add", ["A task"], { dir: "/some/path" }),
      makeTitler(),
      makeStubProfilesGateway(),
    );

    expect(result.status).toBe("error");
  });

  test("returns success with priority badge in humanOutput", async () => {
    const result = await addCommand(
      makeParsed("add", ["A task"], { priority: "high" }),
      makeTitler("High Task"),
      makeStubProfilesGateway(),
    );

    expect(result.status).toBe("success");
    if (result.status === "success") {
      expect(result.humanOutput).toContain("High Task");
    }
  });

  test("includes tags in humanOutput when provided", async () => {
    const result = await addCommand(
      makeParsed("add", ["A task"], {}, { tag: ["frontend"] }),
      makeTitler("Frontend Task"),
      makeStubProfilesGateway(),
    );

    expect(result.status).toBe("success");
    if (result.status === "success") {
      expect(result.humanOutput).toContain("[frontend]");
    }
  });

  test("returns error for invalid --every value", async () => {
    const result = await addCommand(
      makeParsed("add", ["A task"], { every: "invalid-spec" }),
      makeTitler(),
      makeStubProfilesGateway(),
    );

    expect(result.status).toBe("error");
  });

  test("item with already-completed dep lands QUEUED, dependsOn recorded, humanOutput has no 'blocked on'", async () => {
    const dep = makeItem({ status: "completed" });
    await addItem(dep);

    const result = await addCommand(
      makeParsed("add", ["A follow-up task"], {}, { "after-item": [dep.id] }),
      makeTitler("Follow-up Task"),
      makeStubProfilesGateway(),
    );

    expect(result.status).toBe("success");
    if (result.status === "success") {
      expect(result.data.status).toBe("queued");
      expect(result.data.dependsOn).toEqual([dep.id]);
      expect(result.humanOutput).not.toContain("blocked on");
    }
  });

  test("item with pending dep lands BLOCKED (regression guard)", async () => {
    const dep = makeItem({ status: "queued" });
    await addItem(dep);

    const result = await addCommand(
      makeParsed("add", ["A dependent task"], {}, { "after-item": [dep.id] }),
      makeTitler("Dependent Task"),
      makeStubProfilesGateway(),
    );

    expect(result.status).toBe("success");
    if (result.status === "success") {
      expect(result.data.status).toBe("blocked");
      expect(result.humanOutput).toContain("blocked on");
    }
  });
});
