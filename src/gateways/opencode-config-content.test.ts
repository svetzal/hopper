import { describe, expect, test } from "bun:test";
import { buildOpencodeConfigContent } from "./opencode-config-content.ts";

describe("buildOpencodeConfigContent", () => {
  test("returns null when nothing to inject", () => {
    expect(buildOpencodeConfigContent({})).toBeNull();
    expect(
      buildOpencodeConfigContent({ agentName: "rust-craftsperson" }),
    ).toBeNull();
    expect(
      buildOpencodeConfigContent({ craftspersonBody: "   ", appendSystemPrompt: "" }),
    ).toBeNull();
  });

  test("injects the craftsperson body under the agent key", () => {
    const result = buildOpencodeConfigContent({
      agentName: "rust-craftsperson",
      craftspersonBody: "You are a Rust expert. Be concise.",
    });
    expect(result).not.toBeNull();
    const parsed = JSON.parse(result ?? "{}");
    expect(parsed.agent["rust-craftsperson"].prompt).toBe(
      "You are a Rust expert. Be concise.",
    );
    expect(parsed.agent["rust-craftsperson"].mode).toBe("primary");
  });

  test("concatenates appendSystemPrompt after the craftsperson body", () => {
    const result = buildOpencodeConfigContent({
      agentName: "ruby-craftsperson",
      craftspersonBody: "You write idiomatic Ruby.",
      appendSystemPrompt: "Prefer functional patterns.",
    });
    const parsed = JSON.parse(result ?? "{}");
    expect(parsed.agent["ruby-craftsperson"].prompt).toBe(
      "You write idiomatic Ruby.\n\nPrefer functional patterns.",
    );
  });

  test("falls back to a generic agent key when no name is provided", () => {
    const result = buildOpencodeConfigContent({
      appendSystemPrompt: "Be terse.",
    });
    const parsed = JSON.parse(result ?? "{}");
    expect(parsed.agent["hopper-injected"].prompt).toBe("Be terse.");
  });

  test("includes the opencode config schema", () => {
    const result = buildOpencodeConfigContent({
      agentName: "any",
      craftspersonBody: "Body.",
    });
    const parsed = JSON.parse(result ?? "{}");
    expect(parsed.$schema).toBe("https://opencode.ai/config.json");
  });
});
