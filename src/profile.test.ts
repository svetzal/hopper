import { describe, expect, test } from "bun:test";
import {
  isValidProfileName,
  type Profile,
  parseProfile,
  resolveProfileBinding,
  resolveProfileModel,
} from "./profile.ts";

describe("isValidProfileName", () => {
  test.each([
    ["anthropic", true],
    ["openai", true],
    ["ollama-local", true],
    ["my_profile_2", true],
    ["foo123", true],
    // invalid
    ["Anthropic", false], // uppercase
    ["my profile", false], // space
    ["foo.json", false], // dot
    ["", false],
    ["../etc/passwd", false], // path traversal
    ["foo/bar", false],
  ])("'%s' -> %s", (name, expected) => {
    expect(isValidProfileName(name)).toBe(expected);
  });
});

describe("parseProfile", () => {
  function validJson(extra: Record<string, unknown> = {}): string {
    return JSON.stringify({
      runner: "opencode",
      models: {
        deep: "openai/gpt-5.5",
        balanced: "openai/gpt-5.4",
        fast: "openai/gpt-5.4-mini",
      },
      ...extra,
    });
  }

  test("parses a valid opencode profile (string shorthand)", () => {
    const result = parseProfile("openai", validJson());
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.profile).toEqual({
        name: "openai",
        runner: "opencode",
        models: {
          deep: { model: "openai/gpt-5.5" },
          balanced: { model: "openai/gpt-5.4" },
          fast: { model: "openai/gpt-5.4-mini" },
        },
      });
    }
  });

  test("parses a valid claude profile with native aliases", () => {
    const json = JSON.stringify({
      runner: "claude",
      models: { deep: "opus", balanced: "sonnet", fast: "haiku" },
    });
    const result = parseProfile("anthropic", json);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.profile.runner).toBe("claude");
      expect(result.profile.models.deep).toEqual({ model: "opus" });
    }
  });

  test("parses a valid codex profile with native aliases", () => {
    const json = JSON.stringify({
      runner: "codex",
      models: { deep: "gpt-5.5", balanced: "gpt-5.4", fast: "gpt-5.4-mini" },
    });
    const result = parseProfile("codex", json);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.profile.runner).toBe("codex");
      expect(result.profile.models.fast).toEqual({ model: "gpt-5.4-mini" });
    }
  });

  test("parses object-form bindings with effort", () => {
    const json = JSON.stringify({
      runner: "claude",
      models: {
        deep: { model: "opus", effort: "max" },
        balanced: "sonnet",
        fast: { model: "haiku", effort: "low" },
      },
    });
    const result = parseProfile("anthropic", json);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.profile.models.deep).toEqual({ model: "opus", effort: "max" });
      expect(result.profile.models.balanced).toEqual({ model: "sonnet" });
      expect(result.profile.models.fast).toEqual({ model: "haiku", effort: "low" });
    }
  });

  test("preserves user-defined alias keys alongside required tiers", () => {
    const json = JSON.stringify({
      runner: "opencode",
      models: {
        deep: "ollama/qwen3.6:27b-coding-bf16",
        balanced: "ollama/qwen3.6:27b-coding-mxfp8",
        fast: "ollama/qwen3.6:35b-a3b-coding-nvfp4",
        "qwen-bf16": "ollama/qwen3.6:27b-coding-bf16",
        "gpt-oss-large": { model: "ollama/gpt-oss:120b", effort: "high" },
      },
    });
    const result = parseProfile("ollama", json);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.profile.models["qwen-bf16"]).toEqual({
        model: "ollama/qwen3.6:27b-coding-bf16",
      });
      expect(result.profile.models["gpt-oss-large"]).toEqual({
        model: "ollama/gpt-oss:120b",
        effort: "high",
      });
    }
  });

  test("rejects object-form binding with missing 'model'", () => {
    const json = JSON.stringify({
      runner: "claude",
      models: { deep: { effort: "max" }, balanced: "sonnet", fast: "haiku" },
    });
    const result = parseProfile("foo", json);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("deep.model");
  });

  test("rejects object-form binding with non-string effort", () => {
    const json = JSON.stringify({
      runner: "claude",
      models: { deep: { model: "opus", effort: 5 }, balanced: "sonnet", fast: "haiku" },
    });
    const result = parseProfile("foo", json);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("deep.effort");
  });

  test("rejects invalid profile name", () => {
    const result = parseProfile("BadName", validJson());
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("Invalid profile name");
  });

  test("rejects malformed JSON", () => {
    const result = parseProfile("openai", "{ not json");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("Invalid JSON");
  });

  test("rejects non-object top-level value", () => {
    const result = parseProfile("openai", '"hello"');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("must be a JSON object");
  });

  test("rejects array as top-level value", () => {
    const result = parseProfile("openai", "[]");
    expect(result.ok).toBe(false);
  });

  test("rejects unknown runner", () => {
    const json = JSON.stringify({
      runner: "ollama",
      models: { deep: "x", balanced: "y", fast: "z" },
    });
    const result = parseProfile("foo", json);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("Invalid 'runner'");
  });

  test("rejects missing 'models'", () => {
    const result = parseProfile("openai", JSON.stringify({ runner: "claude" }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("'models' must be an object");
  });

  test.each(["deep", "balanced", "fast"])("rejects missing required tier '%s'", (missing) => {
    const tiers = { deep: "a", balanced: "b", fast: "c" };
    delete (tiers as Record<string, string>)[missing];
    const json = JSON.stringify({ runner: "claude", models: tiers });
    const result = parseProfile("foo", json);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain(`Missing required tier '${missing}'`);
  });

  test("rejects empty-string model binding", () => {
    const json = JSON.stringify({
      runner: "claude",
      models: { deep: "", balanced: "sonnet", fast: "haiku" },
    });
    const result = parseProfile("foo", json);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("non-empty string");
  });

  test("rejects non-string model binding", () => {
    const json = JSON.stringify({
      runner: "claude",
      models: { deep: 123, balanced: "sonnet", fast: "haiku" },
    });
    const result = parseProfile("foo", json);
    expect(result.ok).toBe(false);
  });
});

describe("resolveProfileModel", () => {
  const profile: Profile = {
    name: "openai",
    runner: "opencode",
    models: {
      deep: { model: "openai/gpt-5.5" },
      balanced: { model: "openai/gpt-5.4" },
      fast: { model: "openai/gpt-5.4-mini" },
      "gpt-oss-large": { model: "ollama/gpt-oss:120b" },
    },
  };

  test("returns undefined for undefined alias", () => {
    expect(resolveProfileModel(undefined, profile)).toBeUndefined();
  });

  test("maps tier names through the profile", () => {
    expect(resolveProfileModel("deep", profile)).toBe("openai/gpt-5.5");
    expect(resolveProfileModel("balanced", profile)).toBe("openai/gpt-5.4");
    expect(resolveProfileModel("fast", profile)).toBe("openai/gpt-5.4-mini");
  });

  test("maps user-defined aliases", () => {
    expect(resolveProfileModel("gpt-oss-large", profile)).toBe("ollama/gpt-oss:120b");
  });

  test("passes through provider/model IDs verbatim (contains '/')", () => {
    expect(resolveProfileModel("openai/gpt-5.3-codex", profile)).toBe("openai/gpt-5.3-codex");
    expect(resolveProfileModel("ollama/llama3:70b", profile)).toBe("ollama/llama3:70b");
  });

  test("returns unmapped strings unchanged so the runner reports the error", () => {
    expect(resolveProfileModel("unknown-tier", profile)).toBe("unknown-tier");
  });
});

describe("resolveProfileBinding", () => {
  const profile: Profile = {
    name: "anthropic",
    runner: "claude",
    models: {
      deep: { model: "opus", effort: "max" },
      balanced: { model: "sonnet" },
      fast: { model: "haiku", effort: "low" },
    },
  };

  test("returns undefined for undefined alias", () => {
    expect(resolveProfileBinding(undefined, profile)).toBeUndefined();
  });

  test("returns the bound model + effort for a tier with effort", () => {
    expect(resolveProfileBinding("deep", profile)).toEqual({ model: "opus", effort: "max" });
    expect(resolveProfileBinding("fast", profile)).toEqual({ model: "haiku", effort: "low" });
  });

  test("returns model-only binding for tiers without effort", () => {
    expect(resolveProfileBinding("balanced", profile)).toEqual({ model: "sonnet" });
  });

  test("provider-qualified IDs return bare-model bindings (no effort)", () => {
    expect(resolveProfileBinding("openai/gpt-5.3-codex", profile)).toEqual({
      model: "openai/gpt-5.3-codex",
    });
  });

  test("unmapped aliases fall through as bare-model bindings", () => {
    expect(resolveProfileBinding("unknown", profile)).toEqual({ model: "unknown" });
  });
});
