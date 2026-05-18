import { describe, expect, test } from "bun:test";
import type { Profile } from "../profile.ts";
import { buildOpencodeArgv } from "./opencode-argv.ts";

const BIN = "/usr/local/bin/opencode";

const OPENAI_PROFILE: Profile = {
  name: "openai",
  runner: "opencode",
  models: {
    deep: "openai/gpt-5.5",
    balanced: "openai/gpt-5.4",
    fast: "openai/gpt-5.4-mini",
  },
};

describe("buildOpencodeArgv", () => {
  test("minimal invocation: just the subcommand, format, skip-permissions, and prompt", () => {
    expect(buildOpencodeArgv(BIN, "hi")).toEqual([
      BIN,
      "run",
      "--format",
      "json",
      "--dangerously-skip-permissions",
      "--",
      "hi",
    ]);
  });

  test("passes the prompt as a positional after `--`", () => {
    const argv = buildOpencodeArgv(BIN, "a tricky --prompt-looking string");
    expect(argv[argv.length - 2]).toBe("--");
    expect(argv[argv.length - 1]).toBe("a tricky --prompt-looking string");
  });

  test("translates a model tier through the profile's models map", () => {
    const argv = buildOpencodeArgv(BIN, "hi", { model: "deep", profile: OPENAI_PROFILE });
    const modelIdx = argv.indexOf("--model");
    expect(modelIdx).toBeGreaterThan(-1);
    expect(argv[modelIdx + 1]).toBe("openai/gpt-5.5");
  });

  test("passes a native provider/model identifier through unchanged", () => {
    const argv = buildOpencodeArgv(BIN, "hi", {
      model: "openrouter/anthropic/claude-haiku-4.5",
      profile: OPENAI_PROFILE,
    });
    const modelIdx = argv.indexOf("--model");
    expect(argv[modelIdx + 1]).toBe("openrouter/anthropic/claude-haiku-4.5");
  });

  test("forwards model verbatim when no profile is supplied", () => {
    const argv = buildOpencodeArgv(BIN, "hi", { model: "openai/gpt-5.5" });
    const modelIdx = argv.indexOf("--model");
    expect(argv[modelIdx + 1]).toBe("openai/gpt-5.5");
  });

  test("does not include --model when no model is set", () => {
    const argv = buildOpencodeArgv(BIN, "hi");
    expect(argv.includes("--model")).toBe(false);
  });

  test("passes the agent name via --agent", () => {
    const argv = buildOpencodeArgv(BIN, "hi", { agent: "ruby-craftsperson" });
    const idx = argv.indexOf("--agent");
    expect(argv[idx + 1]).toBe("ruby-craftsperson");
  });

  test("passes the cwd via --dir when provided", () => {
    const argv = buildOpencodeArgv(BIN, "hi", {}, "/tmp/work");
    const idx = argv.indexOf("--dir");
    expect(argv[idx + 1]).toBe("/tmp/work");
  });

  test("ignores tool allowlists, denylists, and permissionMode", () => {
    const argv = buildOpencodeArgv(BIN, "hi", {
      tools: ["Read", "Grep"],
      allowedTools: ["Bash(git diff:*)"],
      disallowedTools: ["Bash(git commit:*)"],
      permissionMode: "plan",
    });
    expect(argv.includes("--tools")).toBe(false);
    expect(argv.includes("--allowedTools")).toBe(false);
    expect(argv.includes("--disallowedTools")).toBe(false);
    expect(argv.includes("--permission-mode")).toBe(false);
  });

  test("always uses --dangerously-skip-permissions (hopper worker is unattended)", () => {
    const argv = buildOpencodeArgv(BIN, "hi", { permissionMode: "plan" });
    expect(argv.includes("--dangerously-skip-permissions")).toBe(true);
  });

  test("always uses --format json", () => {
    const argv = buildOpencodeArgv(BIN, "hi");
    const idx = argv.indexOf("--format");
    expect(argv[idx + 1]).toBe("json");
  });

  test("effort is forwarded as --variant", () => {
    const argv = buildOpencodeArgv(BIN, "hi", { effort: "high" });
    const idx = argv.indexOf("--variant");
    expect(idx).toBeGreaterThan(-1);
    expect(argv[idx + 1]).toBe("high");
  });

  test("effort passes through verbatim (no minimal→low remap for opencode)", () => {
    const argv = buildOpencodeArgv(BIN, "hi", { effort: "minimal" });
    const idx = argv.indexOf("--variant");
    expect(argv[idx + 1]).toBe("minimal");
  });

  test("no effort means no --variant flag", () => {
    const argv = buildOpencodeArgv(BIN, "hi");
    expect(argv.includes("--variant")).toBe(false);
  });
});
