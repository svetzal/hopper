import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ParsedArgs } from "../cli.ts";
import { createPresetGateway } from "../gateways/preset-gateway.ts";
import { setPresetGateway } from "../presets.ts";
import { presetCommand } from "./preset.ts";

function makeParsed(
  positional: string[] = [],
  flags: Record<string, string | boolean> = {},
): ParsedArgs {
  return { command: "preset", positional, flags, arrayFlags: {} };
}

describe("presetCommand", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "hopper-preset-test-"));
    setPresetGateway(createPresetGateway(tempDir));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true });
  });

  describe("unknown subcommand", () => {
    test("returns error for unknown subcommand", async () => {
      const result = await presetCommand(makeParsed(["unknown"]));

      expect(result.status).toBe("error");
      if (result.status === "error") {
        expect(result.message).toContain("Usage:");
      }
    });
  });

  describe("preset add", () => {
    test("returns error when name is missing", async () => {
      const result = await presetCommand(makeParsed(["add"]));

      expect(result.status).toBe("error");
      if (result.status === "error") {
        expect(result.message).toContain("Usage:");
      }
    });

    test("returns error when description is missing", async () => {
      const result = await presetCommand(makeParsed(["add", "my-preset"]));

      expect(result.status).toBe("error");
      if (result.status === "error") {
        expect(result.message).toContain("Usage:");
      }
    });

    test("returns success when preset is saved", async () => {
      const result = await presetCommand(makeParsed(["add", "my-preset", "Do some work"]));

      expect(result.status).toBe("success");
      if (result.status === "success") {
        expect(result.humanOutput).toContain("my-preset");
      }
    });
  });

  describe("preset list", () => {
    test("returns empty list message when no presets exist", async () => {
      const result = await presetCommand(makeParsed(["list"]));

      expect(result.status).toBe("success");
      if (result.status === "success") {
        expect(result.humanOutput).toBe("No presets saved.");
      }
    });

    test("returns preset list when presets exist", async () => {
      await presetCommand(makeParsed(["add", "preset-one", "Task one"]));
      await presetCommand(makeParsed(["add", "preset-two", "Task two"]));

      const result = await presetCommand(makeParsed(["list"]));

      expect(result.status).toBe("success");
      if (result.status === "success") {
        expect(result.humanOutput).toContain("preset-one");
        expect(result.humanOutput).toContain("preset-two");
      }
    });
  });

  describe("preset remove", () => {
    test("returns error when name is missing", async () => {
      const result = await presetCommand(makeParsed(["remove"]));

      expect(result.status).toBe("error");
    });

    test("returns success after removing a preset", async () => {
      await presetCommand(makeParsed(["add", "to-remove", "Will be removed"]));

      const result = await presetCommand(makeParsed(["remove", "to-remove"]));

      expect(result.status).toBe("success");
      if (result.status === "success") {
        expect(result.humanOutput).toContain("to-remove");
      }
    });
  });

  describe("preset show", () => {
    test("returns error when name is missing", async () => {
      const result = await presetCommand(makeParsed(["show"]));

      expect(result.status).toBe("error");
    });

    test("returns error when preset does not exist", async () => {
      const result = await presetCommand(makeParsed(["show", "nonexistent"]));

      expect(result.status).toBe("error");
      if (result.status === "error") {
        expect(result.message).toContain("nonexistent");
      }
    });

    test("returns preset details on success", async () => {
      await presetCommand(makeParsed(["add", "my-preset", "Do some work"]));

      const result = await presetCommand(makeParsed(["show", "my-preset"]));

      expect(result.status).toBe("success");
      if (result.status === "success") {
        expect(result.humanOutput).toContain("my-preset");
        expect(result.humanOutput).toContain("Description:");
      }
    });
  });
});
