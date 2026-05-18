import { describe, expect, test } from "bun:test";
import {
  parseRunnerConfig,
  resolveOpencodeModel,
  type RunnerConfig,
} from "./runner-config.ts";

describe("parseRunnerConfig", () => {
  test("parses a valid config", () => {
    const cfg = parseRunnerConfig(
      JSON.stringify({
        opencode: {
          models: {
            opus: "amazon-bedrock/global.anthropic.claude-opus-4-7",
            sonnet: "amazon-bedrock/anthropic.claude-sonnet-4-6",
          },
        },
      }),
    );
    expect(cfg.opencode?.models?.opus).toBe(
      "amazon-bedrock/global.anthropic.claude-opus-4-7",
    );
    expect(cfg.opencode?.models?.sonnet).toBe(
      "amazon-bedrock/anthropic.claude-sonnet-4-6",
    );
  });

  test("returns {} for invalid JSON", () => {
    expect(parseRunnerConfig("not json")).toEqual({});
  });

  test("returns {} for non-object JSON (arrays, primitives, null)", () => {
    expect(parseRunnerConfig("[]")).toEqual({});
    expect(parseRunnerConfig("null")).toEqual({});
    expect(parseRunnerConfig("42")).toEqual({});
    expect(parseRunnerConfig('"hi"')).toEqual({});
  });

  test("returns {} for empty string", () => {
    expect(parseRunnerConfig("")).toEqual({});
  });
});

describe("resolveOpencodeModel", () => {
  const config: RunnerConfig = {
    opencode: {
      models: {
        opus: "amazon-bedrock/global.anthropic.claude-opus-4-7",
        sonnet: "amazon-bedrock/anthropic.claude-sonnet-4-6",
      },
    },
  };

  test("maps a known alias to its configured opencode model ID", () => {
    expect(resolveOpencodeModel("opus", config)).toBe(
      "amazon-bedrock/global.anthropic.claude-opus-4-7",
    );
  });

  test("returns the alias unchanged when not in the map", () => {
    expect(resolveOpencodeModel("haiku", config)).toBe("haiku");
  });

  test("passes provider/model identifiers through unchanged", () => {
    expect(
      resolveOpencodeModel("openrouter/anthropic/claude-haiku-4.5", config),
    ).toBe("openrouter/anthropic/claude-haiku-4.5");
  });

  test("returns undefined when alias is undefined", () => {
    expect(resolveOpencodeModel(undefined, config)).toBeUndefined();
  });

  test("returns the alias unchanged when no config is present", () => {
    expect(resolveOpencodeModel("opus", {})).toBe("opus");
    expect(resolveOpencodeModel("opus", { opencode: {} })).toBe("opus");
  });
});
