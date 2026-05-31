import { describe, expect, test } from "bun:test";
import type { Profile } from "../profile.ts";
import { buildCodexArgv } from "./codex-argv.ts";

const BIN = "/usr/local/bin/codex";

const CODEX_PROFILE: Profile = {
  name: "codex",
  runner: "codex",
  models: {
    deep: { model: "gpt-5.5" },
    balanced: { model: "gpt-5.4" },
    fast: { model: "gpt-5.4-mini" },
  },
};

describe("buildCodexArgv", () => {
  test("minimal invocation uses codex exec JSONL and unattended sandbox bypass", () => {
    expect(buildCodexArgv(BIN, "hi")).toEqual([
      BIN,
      "exec",
      "--json",
      "--color",
      "never",
      "--dangerously-bypass-approvals-and-sandbox",
      "--",
      "hi",
    ]);
  });

  test("passes the prompt as the final positional after `--`", () => {
    const argv = buildCodexArgv(BIN, "a tricky --prompt-looking string");
    expect(argv[argv.length - 2]).toBe("--");
    expect(argv[argv.length - 1]).toBe("a tricky --prompt-looking string");
  });

  test("translates a model tier through the profile's models map", () => {
    const argv = buildCodexArgv(BIN, "hi", { model: "deep", profile: CODEX_PROFILE });
    const modelIdx = argv.indexOf("--model");
    expect(modelIdx).toBeGreaterThan(-1);
    expect(argv[modelIdx + 1]).toBe("gpt-5.5");
  });

  test("forwards model verbatim when no profile is supplied", () => {
    const argv = buildCodexArgv(BIN, "hi", { model: "gpt-5.4" });
    const modelIdx = argv.indexOf("--model");
    expect(argv[modelIdx + 1]).toBe("gpt-5.4");
  });

  test("does not include --model when no model is set", () => {
    const argv = buildCodexArgv(BIN, "hi");
    expect(argv.includes("--model")).toBe(false);
  });

  test("captures the last assistant message when a path is provided", () => {
    const argv = buildCodexArgv(BIN, "hi", {}, "/tmp/result.txt");
    const idx = argv.indexOf("--output-last-message");
    expect(idx).toBeGreaterThan(-1);
    expect(argv[idx + 1]).toBe("/tmp/result.txt");
  });

  test("ignores unsupported SessionOptions at argv level", () => {
    const argv = buildCodexArgv(BIN, "hi", {
      agent: "ruby-craftsperson",
      tools: ["Read", "Grep"],
      allowedTools: ["Bash(git diff:*)"],
      disallowedTools: ["Bash(git commit:*)"],
      permissionMode: "plan",
      effort: "high",
    });
    expect(argv.includes("--agent")).toBe(false);
    expect(argv.includes("--tools")).toBe(false);
    expect(argv.includes("--allowedTools")).toBe(false);
    expect(argv.includes("--disallowedTools")).toBe(false);
    expect(argv.includes("--permission-mode")).toBe(false);
    expect(argv.includes("--effort")).toBe(false);
  });
});
