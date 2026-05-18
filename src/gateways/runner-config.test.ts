import { describe, expect, test } from "bun:test";
import { parseRunnerConfig, type RunnerConfig, resolveOpencodeModel } from "./runner-config.ts";

describe("parseRunnerConfig", () => {
  test("parses a valid config", () => {
    const cfg = parseRunnerConfig(
      JSON.stringify({
        opencode: {
          models: {
            deep: "openai/gpt-5.5",
            balanced: "openai/gpt-5.4",
          },
        },
      }),
    );
    expect(cfg.opencode?.models?.deep).toBe("openai/gpt-5.5");
    expect(cfg.opencode?.models?.balanced).toBe("openai/gpt-5.4");
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
        deep: "openai/gpt-5.5",
        balanced: "openai/gpt-5.4",
      },
    },
  };

  test("maps a known tier to its configured opencode model ID", () => {
    expect(resolveOpencodeModel("deep", config)).toBe("openai/gpt-5.5");
  });

  test("returns the tier name unchanged when not in the map", () => {
    expect(resolveOpencodeModel("fast", config)).toBe("fast");
  });

  test("passes provider/model identifiers through unchanged", () => {
    expect(resolveOpencodeModel("openrouter/anthropic/claude-haiku-4.5", config)).toBe(
      "openrouter/anthropic/claude-haiku-4.5",
    );
  });

  test("returns undefined when alias is undefined", () => {
    expect(resolveOpencodeModel(undefined, config)).toBeUndefined();
  });

  test("returns the tier name unchanged when no config is present", () => {
    expect(resolveOpencodeModel("deep", {})).toBe("deep");
    expect(resolveOpencodeModel("deep", { opencode: {} })).toBe("deep");
  });
});
