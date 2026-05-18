import { describe, expect, test } from "bun:test";
import { buildOpencodeArgv } from "./opencode-argv.ts";
import type { RunnerConfig } from "./runner-config.ts";

const BIN = "/usr/local/bin/opencode";

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

  test("translates a model alias through the runner-config map", () => {
    const config: RunnerConfig = {
      opencode: {
        models: {
          opus: "amazon-bedrock/global.anthropic.claude-opus-4-7",
        },
      },
    };
    const argv = buildOpencodeArgv(BIN, "hi", { model: "opus" }, config);
    const modelIdx = argv.indexOf("--model");
    expect(modelIdx).toBeGreaterThan(-1);
    expect(argv[modelIdx + 1]).toBe(
      "amazon-bedrock/global.anthropic.claude-opus-4-7",
    );
  });

  test("passes a native provider/model identifier through unchanged", () => {
    const argv = buildOpencodeArgv(
      BIN,
      "hi",
      { model: "openrouter/anthropic/claude-haiku-4.5" },
    );
    const modelIdx = argv.indexOf("--model");
    expect(argv[modelIdx + 1]).toBe("openrouter/anthropic/claude-haiku-4.5");
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
    const argv = buildOpencodeArgv(BIN, "hi", {}, {}, "/tmp/work");
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
});
