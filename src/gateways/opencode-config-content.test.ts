import { describe, expect, test } from "bun:test";
import { buildOpencodeConfigContent, resolveOpencodeEnv } from "./opencode-config-content.ts";

describe("resolveOpencodeEnv", () => {
  const baseEnv = { PATH: "/usr/bin", EXISTING: "value" };

  test("returns undefined when neither agent nor appendSystemPrompt is set", () => {
    expect(resolveOpencodeEnv(null, {}, baseEnv)).toBeUndefined();
    expect(resolveOpencodeEnv(null, { agent: undefined, appendSystemPrompt: undefined }, baseEnv)).toBeUndefined();
  });

  test("returns env with OPENCODE_CONFIG_CONTENT and preserved base env when agent has a body", () => {
    const env = resolveOpencodeEnv("You are a Rust expert.", { agent: "rust-craftsperson" }, baseEnv);
    expect(env).not.toBeUndefined();
    expect(env?.PATH).toBe("/usr/bin");
    const config = JSON.parse(env?.OPENCODE_CONFIG_CONTENT ?? "{}");
    expect(config.agent["rust-craftsperson"].prompt).toBe("You are a Rust expert.");
  });

  test("returns undefined when agent is set but body is null and no appendSystemPrompt", () => {
    expect(resolveOpencodeEnv(null, { agent: "some-agent" }, baseEnv)).toBeUndefined();
  });

  test("returns env with OPENCODE_CONFIG_CONTENT when appendSystemPrompt is set with no agent", () => {
    const env = resolveOpencodeEnv(null, { appendSystemPrompt: "Be terse." }, baseEnv);
    expect(env?.OPENCODE_CONFIG_CONTENT).toBeDefined();
    const config = JSON.parse(env?.OPENCODE_CONFIG_CONTENT ?? "{}");
    expect(config.agent["hopper-injected"].prompt).toBe("Be terse.");
  });
});

describe("buildOpencodeConfigContent", () => {
  test("returns null when nothing to inject", () => {
    expect(buildOpencodeConfigContent({})).toBeNull();
    expect(buildOpencodeConfigContent({ agentName: "rust-craftsperson" })).toBeNull();
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
    expect(parsed.agent["rust-craftsperson"].prompt).toBe("You are a Rust expert. Be concise.");
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
