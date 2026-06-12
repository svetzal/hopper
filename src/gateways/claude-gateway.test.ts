import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createClaudeRunner } from "./claude-gateway.ts";

async function makeFakeBin(dir: string, name: string, lines: string[]): Promise<void> {
  const bin = join(dir, name);
  await writeFile(bin, `${lines.join("\n")}\n`);
  await chmod(bin, 0o755);
}

// Reads FAKE_CLAUDE_STDOUT / FAKE_CLAUDE_STDERR / FAKE_CLAUDE_EXIT from the
// subprocess environment (passed explicitly via SessionOptions.env).
const FAKE_CLAUDE_SCRIPT = [
  "#!/bin/sh",
  'printf "%s" "$FAKE_CLAUDE_STDOUT"',
  '[ -n "$FAKE_CLAUDE_STDERR" ] && printf "%s" "$FAKE_CLAUDE_STDERR" >&2',
  `exit "\${FAKE_CLAUDE_EXIT:-0}"`,
];

describe("claude-gateway", () => {
  let fakeDir = "";
  let tempDir = "";
  const originalPath = process.env.PATH;

  beforeEach(async () => {
    fakeDir = await mkdtemp(join(tmpdir(), "fake-claude-"));
    tempDir = await mkdtemp(join(tmpdir(), "claude-gw-test-"));
    await makeFakeBin(fakeDir, "claude", FAKE_CLAUDE_SCRIPT);
    // Bun.which uses process.env.PATH only when the PATH option is explicit;
    // the resolve*Bin functions were updated to pass { PATH: process.env.PATH }.
    process.env.PATH = `${fakeDir}:${originalPath}`;
  });

  afterEach(async () => {
    process.env.PATH = originalPath;
    await rm(fakeDir, { recursive: true, force: true });
    await rm(tempDir, { recursive: true, force: true });
    fakeDir = "";
    tempDir = "";
  });

  test("stdout JSONL is captured in audit file and result matches extractResult", async () => {
    const auditFile = join(tempDir, "audit.jsonl");
    const runner = createClaudeRunner();
    const { result } = await runner.runSession("test prompt", tempDir, auditFile, {
      env: { FAKE_CLAUDE_STDOUT: '{"type":"result","result":"hello from claude"}\n' },
    });

    expect(result).toBe("hello from claude");
    const content = await readFile(auditFile, "utf8");
    expect(content).toContain('"type":"result"');
    expect(content).toContain('"hello from claude"');
  });

  test("stderr is appended as a JSONL stderr event", async () => {
    const auditFile = join(tempDir, "audit.jsonl");
    const runner = createClaudeRunner();
    await runner.runSession("test prompt", tempDir, auditFile, {
      env: {
        FAKE_CLAUDE_STDOUT: '{"type":"result","result":"ok"}\n',
        FAKE_CLAUDE_STDERR: "some error output",
      },
    });

    const content = await readFile(auditFile, "utf8");
    const lines = content.split("\n").filter((l) => l.trim().length > 0);
    const stderrLine = lines.find((l) => {
      try {
        return (JSON.parse(l) as { type?: string }).type === "stderr";
      } catch {
        return false;
      }
    });
    expect(stderrLine).toBeDefined();
    const parsed = JSON.parse(stderrLine ?? "") as { type: string; text: string };
    expect(parsed.text).toContain("some error output");
  });

  test("no stderr event is appended when stderr is empty", async () => {
    const auditFile = join(tempDir, "audit.jsonl");
    const runner = createClaudeRunner();
    await runner.runSession("test prompt", tempDir, auditFile, {
      env: { FAKE_CLAUDE_STDOUT: '{"type":"result","result":"ok"}\n' },
    });

    const content = await readFile(auditFile, "utf8");
    const hasStderrEvent = content
      .split("\n")
      .filter((l) => l.trim().length > 0)
      .some((l) => {
        try {
          return (JSON.parse(l) as { type?: string }).type === "stderr";
        } catch {
          return false;
        }
      });
    expect(hasStderrEvent).toBe(false);
  });

  test("append: true preserves prior audit content via session-separator preamble", async () => {
    const auditFile = join(tempDir, "audit.jsonl");
    const priorContent = '{"type":"result","result":"prior session"}\n';
    await writeFile(auditFile, priorContent);

    const runner = createClaudeRunner();
    await runner.runSession("test prompt", tempDir, auditFile, {
      append: true,
      env: { FAKE_CLAUDE_STDOUT: '{"type":"result","result":"new session"}\n' },
    });

    const content = await readFile(auditFile, "utf8");
    expect(content).toContain('"prior session"');
    expect(content).toContain("session-separator");
    expect(content).toContain('"new session"');
  });

  test("exitCode is propagated from the subprocess", async () => {
    const auditFile = join(tempDir, "audit.jsonl");
    const runner = createClaudeRunner();
    const { exitCode } = await runner.runSession("test prompt", tempDir, auditFile, {
      env: { FAKE_CLAUDE_EXIT: "3" },
    });

    expect(exitCode).toBe(3);
  });

  test("runSession rejects with 'claude executable not found' when PATH has no claude", async () => {
    process.env.PATH = "";
    const runner = createClaudeRunner();
    await expect(
      runner.runSession("test prompt", tempDir, join(tempDir, "audit.jsonl")),
    ).rejects.toThrow("claude executable not found");
  });

  test("generateText delegates through runSession and returns trimmed text", async () => {
    // Override the fake claude in fakeDir to emit a fixed result JSONL line so
    // we do not depend on env inheritance from the parent process.
    await makeFakeBin(fakeDir, "claude", [
      "#!/bin/sh",
      'printf \'{"type":"result","result":"branch-slug-result"}\\n\'',
    ]);
    const runner = createClaudeRunner();
    const profile = {
      name: "anthropic",
      runner: "claude" as const,
      models: {
        deep: { model: "opus" },
        balanced: { model: "sonnet" },
        fast: { model: "haiku" },
      },
    };
    const { exitCode, text } = await runner.generateText("summarize this", "balanced", {
      profile,
      cwd: tempDir,
    });
    expect(exitCode).toBe(0);
    expect(text).toBe("branch-slug-result");
  });
});
