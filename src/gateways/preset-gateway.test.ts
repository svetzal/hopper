import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Preset } from "../presets.ts";
import { createPresetGateway } from "./preset-gateway.ts";

function makePreset(overrides?: Partial<Preset>): Preset {
  return {
    name: "test-preset",
    description: "A test description",
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

describe("PresetGateway", () => {
  let tempDir: string;

  afterEach(async () => {
    if (tempDir) {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  async function setup() {
    tempDir = await mkdtemp(join(tmpdir(), "preset-gw-"));
    return createPresetGateway(tempDir);
  }

  test("load returns [] when file does not exist", async () => {
    const gateway = await setup();
    const presets = await gateway.load();
    expect(presets).toEqual([]);
  });

  test("load returns [] when file contains invalid JSON", async () => {
    const gateway = await setup();
    await Bun.write(join(tempDir, "presets.json"), "{ not valid json }}}");
    const presets = await gateway.load();
    expect(presets).toEqual([]);
  });

  test("save then load round-trips an array of presets", async () => {
    const gateway = await setup();
    const presets = [
      makePreset({ name: "first" }),
      makePreset({ name: "second", workingDir: "/tmp/project" }),
    ];
    await gateway.save(presets);
    const loaded = await gateway.load();
    expect(loaded).toHaveLength(2);
    expect(loaded[0]?.name).toBe("first");
    expect(loaded[1]?.workingDir).toBe("/tmp/project");
  });

  test("save creates the directory if it does not exist", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "preset-gw-"));
    const nestedDir = join(tempDir, "deeply", "nested");
    const gateway = createPresetGateway(nestedDir);
    const presets = [makePreset()];
    await gateway.save(presets);
    const loaded = await gateway.load();
    expect(loaded).toHaveLength(1);
  });
});
