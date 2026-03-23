import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Preset } from "./presets.ts";
import {
  addPreset,
  findPreset,
  loadPresets,
  removePreset,
  setPresetsDir,
  validatePresetName,
} from "./presets.ts";

describe("presets", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "hopper-presets-test-"));
    setPresetsDir(tempDir);
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true });
  });

  function makePreset(overrides?: Partial<Preset>): Preset {
    return {
      name: "test-preset",
      description: "A test description",
      createdAt: new Date().toISOString(),
      ...overrides,
    };
  }

  test("loadPresets returns empty array when no file exists", async () => {
    const presets = await loadPresets();
    expect(presets).toEqual([]);
  });

  test("addPreset stores correctly", async () => {
    const preset = makePreset({ name: "hone-mailctl" });
    await addPreset(preset);

    const presets = await loadPresets();
    expect(presets).toHaveLength(1);
    expect(presets[0]?.name).toBe("hone-mailctl");
    expect(presets[0]?.description).toBe("A test description");
  });

  test("addPreset stores workingDir and branch", async () => {
    const preset = makePreset({
      name: "with-dir",
      workingDir: "/tmp/project",
      branch: "main",
    });
    await addPreset(preset);

    const presets = await loadPresets();
    expect(presets[0]?.workingDir).toBe("/tmp/project");
    expect(presets[0]?.branch).toBe("main");
  });

  test("findPreset returns match (case-insensitive)", async () => {
    await addPreset(makePreset({ name: "my-preset" }));

    const found = await findPreset("MY-PRESET");
    expect(found).toBeDefined();
    expect(found?.name).toBe("my-preset");
  });

  test("findPreset returns undefined for missing", async () => {
    await addPreset(makePreset({ name: "existing" }));

    const found = await findPreset("nonexistent");
    expect(found).toBeUndefined();
  });

  test("removePreset removes and returns the preset", async () => {
    await addPreset(makePreset({ name: "to-remove" }));

    const removed = await removePreset("to-remove");
    expect(removed.name).toBe("to-remove");

    const presets = await loadPresets();
    expect(presets).toHaveLength(0);
  });

  test("removePreset throws for missing", async () => {
    await expect(removePreset("nonexistent")).rejects.toThrow(
      "No preset found with name: nonexistent",
    );
  });

  test("validatePresetName rejects empty name", () => {
    expect(() => validatePresetName("")).toThrow("cannot be empty");
  });

  test("validatePresetName rejects names with spaces", () => {
    expect(() => validatePresetName("my preset")).toThrow(
      "alphanumeric characters, hyphens, and underscores",
    );
  });

  test("validatePresetName rejects special characters", () => {
    expect(() => validatePresetName("my@preset!")).toThrow(
      "alphanumeric characters, hyphens, and underscores",
    );
  });

  test("validatePresetName rejects names over 64 characters", () => {
    const longName = "a".repeat(65);
    expect(() => validatePresetName(longName)).toThrow("64 characters or fewer");
  });

  test("validatePresetName normalizes to lowercase", () => {
    expect(validatePresetName("My-Preset")).toBe("my-preset");
  });

  test("validatePresetName accepts valid names", () => {
    expect(validatePresetName("hone-mailctl_v2")).toBe("hone-mailctl_v2");
  });

  test("addPreset rejects duplicate names without --force", async () => {
    await addPreset(makePreset({ name: "duplicate" }));

    await expect(
      addPreset(makePreset({ name: "duplicate", description: "new desc" })),
    ).rejects.toThrow('Preset "duplicate" already exists');
  });

  test("addPreset overwrites with --force", async () => {
    await addPreset(makePreset({ name: "overwrite", description: "original" }));
    await addPreset(makePreset({ name: "overwrite", description: "updated" }), true);

    const presets = await loadPresets();
    expect(presets).toHaveLength(1);
    expect(presets[0]?.description).toBe("updated");
  });
});
