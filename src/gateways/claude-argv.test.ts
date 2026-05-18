import { describe, expect, test } from "bun:test";
import type { Profile } from "../profile.ts";
import { buildClaudeArgv } from "./claude-argv.ts";

const ANTHROPIC_PROFILE: Profile = {
  name: "anthropic",
  runner: "claude",
  models: {
    deep: { model: "opus" },
    balanced: { model: "sonnet" },
    fast: { model: "haiku" },
  },
};

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

  test("native model alias is passed verbatim via --model", () => {
    const argv = buildClaudeArgv("claude", "p", { model: "opus" });
    const i = argv.indexOf("--model");
    expect(i).toBeGreaterThan(-1);
    expect(argv[i + 1]).toBe("opus");
  });

  test("tier 'deep' translates to claude's 'opus' alias via anthropic profile", () => {
    const argv = buildClaudeArgv("claude", "p", { model: "deep", profile: ANTHROPIC_PROFILE });
    const i = argv.indexOf("--model");
    expect(argv[i + 1]).toBe("opus");
  });

  test("tier 'balanced' translates to claude's 'sonnet' alias via anthropic profile", () => {
    const argv = buildClaudeArgv("claude", "p", { model: "balanced", profile: ANTHROPIC_PROFILE });
    const i = argv.indexOf("--model");
    expect(argv[i + 1]).toBe("sonnet");
  });

  test("tier 'fast' translates to claude's 'haiku' alias via anthropic profile", () => {
    const argv = buildClaudeArgv("claude", "p", { model: "fast", profile: ANTHROPIC_PROFILE });
    const i = argv.indexOf("--model");
    expect(argv[i + 1]).toBe("haiku");
  });

  test("without a profile, model passes through verbatim", () => {
    const argv = buildClaudeArgv("claude", "p", { model: "deep" });
    const i = argv.indexOf("--model");
    // No profile means no resolution; the CLI will surface bad names itself.
    expect(argv[i + 1]).toBe("deep");
  });

  test("native provider/model identifiers pass through unchanged", () => {
    const argv = buildClaudeArgv("claude", "p", { model: "claude-opus-4-7" });
    const i = argv.indexOf("--model");
    expect(argv[i + 1]).toBe("claude-opus-4-7");
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

  test("effort is forwarded as --effort", () => {
    const argv = buildClaudeArgv("claude", "p", { effort: "high" });
    const i = argv.indexOf("--effort");
    expect(i).toBeGreaterThan(-1);
    expect(argv[i + 1]).toBe("high");
  });

  test("effort=minimal maps to --effort low (claude has no minimal)", () => {
    const argv = buildClaudeArgv("claude", "p", { effort: "minimal" });
    const i = argv.indexOf("--effort");
    expect(i).toBeGreaterThan(-1);
    expect(argv[i + 1]).toBe("low");
  });

  test("effort passes through runner-native values (xhigh) verbatim", () => {
    const argv = buildClaudeArgv("claude", "p", { effort: "xhigh" });
    const i = argv.indexOf("--effort");
    expect(argv[i + 1]).toBe("xhigh");
  });

  test("no effort means no --effort flag", () => {
    const argv = buildClaudeArgv("claude", "p");
    expect(argv.includes("--effort")).toBe(false);
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
