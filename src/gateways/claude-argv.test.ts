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
      "--",
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

  test("regression: prompt is last even with multi-value --tools (Commander variadic does not eat it)", () => {
    // This was the v2.0.0 bug: claude's Commander-variadic --tools greedily
    // consumed all following positionals, including the prompt, so the CLI
    // died with "Input must be provided either through stdin or as a prompt
    // argument when using --print". Joining into one token + `--` sentinel
    // keeps the prompt unambiguous.
    const argv = buildClaudeArgv("claude", "MY_PROMPT", {
      tools: ["Read", "Grep", "Glob", "WebFetch", "WebSearch", "Task"],
    });
    expect(argv[argv.length - 1]).toBe("MY_PROMPT");
    expect(argv[argv.length - 2]).toBe("--");
  });

  test("regression: prompt is last with multi-value --allowedTools", () => {
    const argv = buildClaudeArgv("claude", "MY_PROMPT", {
      allowedTools: ["Bash(git diff:*)", "Bash(git status:*)", "Bash(git log:*)"],
    });
    expect(argv[argv.length - 1]).toBe("MY_PROMPT");
  });

  test("regression: prompt is last with multi-value --disallowedTools", () => {
    const argv = buildClaudeArgv("claude", "MY_PROMPT", {
      disallowedTools: ["Bash(git commit:*)", "Bash(git push:*)"],
    });
    expect(argv[argv.length - 1]).toBe("MY_PROMPT");
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

  test("tools are passed as a single comma-joined token", () => {
    const argv = buildClaudeArgv("claude", "p", { tools: ["Read", "Grep", "Glob"] });
    const i = argv.indexOf("--tools");
    expect(i).toBeGreaterThan(-1);
    expect(argv[i + 1]).toBe("Read,Grep,Glob");
  });

  test('tools: [""] disables all tools (single empty-string token)', () => {
    const argv = buildClaudeArgv("claude", "p", { tools: [""] });
    const i = argv.indexOf("--tools");
    expect(i).toBeGreaterThan(-1);
    expect(argv[i + 1]).toBe("");
  });

  test("empty tools array is ignored (no --tools emitted)", () => {
    const argv = buildClaudeArgv("claude", "p", { tools: [] });
    expect(argv).not.toContain("--tools");
  });

  test("allowedTools are passed as a single comma-joined token", () => {
    const argv = buildClaudeArgv("claude", "p", {
      allowedTools: ["Bash(git diff:*)", "Bash(git log:*)"],
    });
    const i = argv.indexOf("--allowedTools");
    expect(i).toBeGreaterThan(-1);
    expect(argv[i + 1]).toBe("Bash(git diff:*),Bash(git log:*)");
  });

  test("disallowedTools are passed as a single comma-joined token", () => {
    const argv = buildClaudeArgv("claude", "p", { disallowedTools: ["Edit", "Write"] });
    const i = argv.indexOf("--disallowedTools");
    expect(i).toBeGreaterThan(-1);
    expect(argv[i + 1]).toBe("Edit,Write");
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
    expect(argv[argv.length - 2]).toBe("--");
  });
});
