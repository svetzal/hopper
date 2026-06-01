import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmod, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Profile } from "../profile.ts";
import { createCodexRunner } from "./codex-gateway.ts";

async function makeFakeBin(dir: string, name: string, lines: string[]): Promise<void> {
  const bin = join(dir, name);
  await writeFile(bin, `${lines.join("\n")}\n`);
  await chmod(bin, 0o755);
}

// Parses --output-last-message <path> from argv, reads control vars from the
// subprocess env (passed explicitly via SessionOptions.env), and writes
// FAKE_CODEX_RESULT to the result file when provided.
const FAKE_CODEX_SCRIPT = [
  "#!/bin/sh",
  'OUTPUT_FILE=""',
  "while [ $# -gt 0 ]; do",
  '  case "$1" in',
  "    --output-last-message)",
  '      OUTPUT_FILE="$2"',
  "      shift 2",
  "      ;;",
  "    --)",
  "      shift",
  "      break",
  "      ;;",
  "    *)",
  "      shift",
  "      ;;",
  "  esac",
  "done",
  'printf "%s" "$FAKE_CODEX_STDOUT"',
  '[ -n "$FAKE_CODEX_STDERR" ] && printf "%s" "$FAKE_CODEX_STDERR" >&2',
  '[ -n "$OUTPUT_FILE" ] && printf "%s" "$FAKE_CODEX_RESULT" > "$OUTPUT_FILE"',
  `exit "\${FAKE_CODEX_EXIT:-0}"`,
];

const TEST_PROFILE: Profile = {
  name: "test",
  runner: "codex",
  models: {
    deep: { model: "test-deep" },
    balanced: { model: "test-balanced" },
    fast: { model: "test-fast" },
  },
};

describe("codex-gateway", () => {
  let fakeDir = "";
  let tempDir = "";
  const originalPath = process.env.PATH;

  beforeEach(async () => {
    fakeDir = await mkdtemp(join(tmpdir(), "fake-codex-"));
    tempDir = await mkdtemp(join(tmpdir(), "codex-gw-test-"));
    await makeFakeBin(fakeDir, "codex", FAKE_CODEX_SCRIPT);
    process.env.PATH = `${fakeDir}:${originalPath}`;
  });

  afterEach(async () => {
    process.env.PATH = originalPath;
    await rm(fakeDir, { recursive: true, force: true });
    await rm(tempDir, { recursive: true, force: true });
    fakeDir = "";
    tempDir = "";
  });

  test("result is read from the output-last-message file and trimmed", async () => {
    const auditFile = join(tempDir, "audit.jsonl");
    const runner = createCodexRunner();
    const { result } = await runner.runSession("test prompt", tempDir, auditFile, {
      env: { FAKE_CODEX_RESULT: "  codex result text  " },
    });

    expect(result).toBe("codex result text");
  });

  test("temp result file is unlinked after the call", async () => {
    const auditFile = join(tempDir, "audit.jsonl");
    const td = tmpdir();
    const existingFiles = new Set(
      (await readdir(td)).filter((f) => f.startsWith("hopper-codex-result-")),
    );

    const runner = createCodexRunner();
    await runner.runSession("test prompt", tempDir, auditFile, {
      env: { FAKE_CODEX_RESULT: "some result" },
    });

    const afterFiles = (await readdir(td)).filter((f) => f.startsWith("hopper-codex-result-"));
    const newFiles = afterFiles.filter((f) => !existingFiles.has(f));
    expect(newFiles).toHaveLength(0);
  });

  test("stderr is appended as a synthetic stderr JSONL event", async () => {
    const auditFile = join(tempDir, "audit.jsonl");
    const runner = createCodexRunner();
    await runner.runSession("test prompt", tempDir, auditFile, {
      env: { FAKE_CODEX_STDERR: "codex error text" },
    });

    const content = await Bun.file(auditFile).text();
    const stderrLine = content
      .split("\n")
      .filter((l) => l.trim().length > 0)
      .find((l) => {
        try {
          return (JSON.parse(l) as { type?: string }).type === "stderr";
        } catch {
          return false;
        }
      });
    expect(stderrLine).toBeDefined();
    const parsed = JSON.parse(stderrLine ?? "") as { type: string; text: string };
    expect(parsed.text).toContain("codex error text");
  });

  test("injected loadCraftsperson is called when agent is set in options", async () => {
    const auditFile = join(tempDir, "audit.jsonl");
    let loaderCalledWith: string | undefined;
    const loadCraftsperson = async (name: string) => {
      loaderCalledWith = name;
      return "# Craftsperson guidance\n\nDo great work.";
    };

    const runner = createCodexRunner({ loadCraftsperson });
    await runner.runSession("test prompt", tempDir, auditFile, {
      agent: "my-craftsperson",
      env: { FAKE_CODEX_RESULT: "" },
    });

    expect(loaderCalledWith).toBe("my-craftsperson");
  });

  test("generateText unlinks temp audit file in finally block", async () => {
    const td = tmpdir();
    const existingFiles = new Set(
      (await readdir(td)).filter((f) => f.startsWith("hopper-codex-gen-")),
    );

    const runner = createCodexRunner();
    await runner.generateText("test prompt", "fast", {
      profile: TEST_PROFILE,
      cwd: tempDir,
    });

    const afterFiles = (await readdir(td)).filter((f) => f.startsWith("hopper-codex-gen-"));
    const newFiles = afterFiles.filter((f) => !existingFiles.has(f));
    expect(newFiles).toHaveLength(0);
  });
});
