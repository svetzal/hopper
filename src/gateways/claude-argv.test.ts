import { describe, expect, test } from "bun:test";
import { buildClaudeArgv } from "./claude-argv.ts";

describe("buildClaudeArgv", () => {
  test("with no options, produces the legacy invocation", () => {
    const argv = buildClaudeArgv("/usr/local/bin/claude", "do the thing");

    expect(argv).toEqual([
      "/usr/local/bin/claude",
      "--print",
      "--verbose",
      "--dangerously-skip-permissions",
      "--output-format",
      "stream-json",
      "do the thing",
    ]);
  });

  test("prompt is always the last arg", () => {
    const argv = buildClaudeArgv("claude", "PROMPT", {
      model: "opus",
      agent: "typescript-craftsperson",
      allowedTools: ["Bash(git diff:*)"],
    });

    expect(argv[argv.length - 1]).toBe("PROMPT");
  });

  test("model is passed via --model", () => {
    const argv = buildClaudeArgv("claude", "p", { model: "opus" });
    const i = argv.indexOf("--model");
    expect(i).toBeGreaterThan(-1);
    expect(argv[i + 1]).toBe("opus");
  });

  test("agent is passed via --agent", () => {
    const argv = buildClaudeArgv("claude", "p", { agent: "rust-craftsperson" });
    const i = argv.indexOf("--agent");
    expect(i).toBeGreaterThan(-1);
    expect(argv[i + 1]).toBe("rust-craftsperson");
  });

  test("tools are passed as a variadic --tools list", () => {
    const argv = buildClaudeArgv("claude", "p", { tools: ["Read", "Grep", "Glob"] });
    const i = argv.indexOf("--tools");
    expect(i).toBeGreaterThan(-1);
    expect(argv.slice(i + 1, i + 4)).toEqual(["Read", "Grep", "Glob"]);
  });

  test('tools: [""] disables all tools', () => {
    const argv = buildClaudeArgv("claude", "p", { tools: [""] });
    const i = argv.indexOf("--tools");
    expect(i).toBeGreaterThan(-1);
    expect(argv[i + 1]).toBe("");
  });

  test("empty tools array is ignored (no --tools emitted)", () => {
    const argv = buildClaudeArgv("claude", "p", { tools: [] });
    expect(argv).not.toContain("--tools");
  });

  test("allowedTools are passed variadically", () => {
    const argv = buildClaudeArgv("claude", "p", {
      allowedTools: ["Bash(git diff:*)", "Bash(git log:*)"],
    });
    const i = argv.indexOf("--allowedTools");
    expect(i).toBeGreaterThan(-1);
    expect(argv.slice(i + 1, i + 3)).toEqual(["Bash(git diff:*)", "Bash(git log:*)"]);
  });

  test("disallowedTools are passed variadically", () => {
    const argv = buildClaudeArgv("claude", "p", { disallowedTools: ["Edit", "Write"] });
    const i = argv.indexOf("--disallowedTools");
    expect(i).toBeGreaterThan(-1);
    expect(argv.slice(i + 1, i + 3)).toEqual(["Edit", "Write"]);
  });

  test("permissionMode replaces --dangerously-skip-permissions", () => {
    const argv = buildClaudeArgv("claude", "p", { permissionMode: "plan" });
    expect(argv).not.toContain("--dangerously-skip-permissions");
    const i = argv.indexOf("--permission-mode");
    expect(i).toBeGreaterThan(-1);
    expect(argv[i + 1]).toBe("plan");
  });

  test("no permissionMode keeps --dangerously-skip-permissions (legacy default)", () => {
    const argv = buildClaudeArgv("claude", "p", { model: "sonnet" });
    expect(argv).toContain("--dangerously-skip-permissions");
    expect(argv).not.toContain("--permission-mode");
  });

  test("appendSystemPrompt is forwarded", () => {
    const argv = buildClaudeArgv("claude", "p", { appendSystemPrompt: "Extra guidance." });
    const i = argv.indexOf("--append-system-prompt");
    expect(i).toBeGreaterThan(-1);
    expect(argv[i + 1]).toBe("Extra guidance.");
  });

  test("multiple options compose without mutual interference", () => {
    const argv = buildClaudeArgv("claude", "do it", {
      model: "opus",
      agent: "python-craftsperson",
      tools: ["Read", "Grep"],
      allowedTools: ["Bash(ls:*)"],
      disallowedTools: ["Edit"],
      permissionMode: "plan",
      appendSystemPrompt: "Be careful.",
    });

    expect(argv).toContain("--model");
    expect(argv).toContain("--agent");
    expect(argv).toContain("--tools");
    expect(argv).toContain("--allowedTools");
    expect(argv).toContain("--disallowedTools");
    expect(argv).toContain("--permission-mode");
    expect(argv).toContain("--append-system-prompt");
    expect(argv).not.toContain("--dangerously-skip-permissions");
    expect(argv[argv.length - 1]).toBe("do it");
  });
});
