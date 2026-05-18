import { describe, expect, test } from "bun:test";
import { CLAUDE_TIER_MAP, isModelTier, MODEL_TIERS, resolveClaudeModel } from "./model-tier.ts";

describe("MODEL_TIERS", () => {
  test("lists tiers from smartest to fastest", () => {
    expect(MODEL_TIERS).toEqual(["deep", "balanced", "fast"]);
  });
});

describe("CLAUDE_TIER_MAP", () => {
  test("maps each tier to its native Anthropic alias", () => {
    expect(CLAUDE_TIER_MAP).toEqual({
      deep: "opus",
      balanced: "sonnet",
      fast: "haiku",
    });
  });
});

describe("resolveClaudeModel", () => {
  test("maps tier names to claude's native aliases", () => {
    expect(resolveClaudeModel("deep")).toBe("opus");
    expect(resolveClaudeModel("balanced")).toBe("sonnet");
    expect(resolveClaudeModel("fast")).toBe("haiku");
  });

  test("passes legacy native aliases through unchanged", () => {
    expect(resolveClaudeModel("opus")).toBe("opus");
    expect(resolveClaudeModel("sonnet")).toBe("sonnet");
    expect(resolveClaudeModel("haiku")).toBe("haiku");
  });

  test("passes runner-native model IDs through unchanged", () => {
    expect(resolveClaudeModel("claude-opus-4-7")).toBe("claude-opus-4-7");
    expect(resolveClaudeModel("anthropic/claude-haiku-4-5-20251001")).toBe(
      "anthropic/claude-haiku-4-5-20251001",
    );
  });
});

describe("isModelTier", () => {
  test("recognises the three tier names", () => {
    expect(isModelTier("deep")).toBe(true);
    expect(isModelTier("balanced")).toBe(true);
    expect(isModelTier("fast")).toBe(true);
  });

  test("rejects native aliases and arbitrary strings", () => {
    expect(isModelTier("opus")).toBe(false);
    expect(isModelTier("sonnet")).toBe(false);
    expect(isModelTier("haiku")).toBe(false);
    expect(isModelTier("openai/gpt-5.5")).toBe(false);
    expect(isModelTier("")).toBe(false);
  });
});
