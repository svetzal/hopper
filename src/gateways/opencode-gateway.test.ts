import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createOpencodeRunner } from "./opencode-gateway.ts";

// Use process.pid to make file paths unique per test worker so parallel test
// files can't collide.
const PID = process.pid;
const TD = tmpdir();
const RUN_STDOUT_FILE = join(TD, `hopper-test-oc-run-stdout-${PID}.txt`);
const RUN_STDERR_FILE = join(TD, `hopper-test-oc-run-stderr-${PID}.txt`);
const RUN_EXIT_FILE = join(TD, `hopper-test-oc-run-exit-${PID}.txt`);
const EXPORT_STDOUT_FILE = join(TD, `hopper-test-oc-export-stdout-${PID}.txt`);
const EXPORT_EXIT_FILE = join(TD, `hopper-test-oc-export-exit-${PID}.txt`);

// Fake binary handles both `opencode run` and `opencode export` subcommands.
// It reads its behavior from temp files whose paths are embedded at script-
// creation time.  This avoids any reliance on env-var propagation to the
// `export` subprocess (which is spawned without an explicit env by the gateway).
const FAKE_OPENCODE_SCRIPT = `${[
  "#!/bin/sh",
  'SUBCMD="$1"',
  'case "$SUBCMD" in',
  "  run)",
  `    cat "${RUN_STDOUT_FILE}" 2>/dev/null`,
  `    [ -f "${RUN_STDERR_FILE}" ] && cat "${RUN_STDERR_FILE}" >&2`,
  `    EXIT_CODE=$(cat "${RUN_EXIT_FILE}" 2>/dev/null || printf '0')`,
  `    exit "$EXIT_CODE"`,
  "    ;;",
  "  export)",
  `    cat "${EXPORT_STDOUT_FILE}" 2>/dev/null`,
  `    EXIT_CODE=$(cat "${EXPORT_EXIT_FILE}" 2>/dev/null || printf '0')`,
  `    exit "$EXIT_CODE"`,
  "    ;;",
  "  *)",
  "    exit 0",
  "    ;;",
  "esac",
].join("\n")}\n`;

async function makeFakeBin(dir: string, name: string, script: string): Promise<void> {
  const bin = join(dir, name);
  await writeFile(bin, script);
  await chmod(bin, 0o755);
}

async function writeControl(file: string, content: string): Promise<void> {
  await writeFile(file, content);
}

async function deleteControl(...files: string[]): Promise<void> {
  await Promise.all(files.map((f) => rm(f, { force: true })));
}

function makeExportDoc(text: string): string {
  return JSON.stringify({
    messages: [{ info: { role: "assistant" }, parts: [{ type: "text", text }] }],
  });
}

describe("opencode-gateway", () => {
  let fakeDir = "";
  let tempDir = "";
  const originalPath = process.env.PATH;

  beforeEach(async () => {
    fakeDir = await mkdtemp(join(TD, "fake-opencode-"));
    tempDir = await mkdtemp(join(TD, "opencode-gw-test-"));
    await makeFakeBin(fakeDir, "opencode", FAKE_OPENCODE_SCRIPT);
    process.env.PATH = `${fakeDir}:${originalPath}`;
  });

  afterEach(async () => {
    process.env.PATH = originalPath;
    await deleteControl(
      RUN_STDOUT_FILE,
      RUN_STDERR_FILE,
      RUN_EXIT_FILE,
      EXPORT_STDOUT_FILE,
      EXPORT_EXIT_FILE,
    );
    await rm(fakeDir, { recursive: true, force: true });
    await rm(tempDir, { recursive: true, force: true });
    fakeDir = "";
    tempDir = "";
  });

  test("stderr is appended as a synthetic JSONL stderr event", async () => {
    const auditFile = join(tempDir, "audit.jsonl");
    await writeControl(RUN_STDERR_FILE, "opencode error output");

    const runner = createOpencodeRunner();
    await runner.runSession("test prompt", tempDir, auditFile);

    const content = await readFile(auditFile, "utf8");
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
    expect(parsed.text).toContain("opencode error output");
  });

  test("when sessionID is found, export is called and opencode-export event is appended", async () => {
    const auditFile = join(tempDir, "audit.jsonl");
    await writeControl(RUN_STDOUT_FILE, '{"type":"step_start","sessionID":"ses_abc123"}\n');
    await writeControl(EXPORT_STDOUT_FILE, makeExportDoc("the final answer"));

    const runner = createOpencodeRunner();
    const { result } = await runner.runSession("test prompt", tempDir, auditFile);

    expect(result).toBe("the final answer");

    const content = await readFile(auditFile, "utf8");
    const exportLine = content
      .split("\n")
      .filter((l) => l.trim().length > 0)
      .find((l) => {
        try {
          return (JSON.parse(l) as { type?: string }).type === "opencode-export";
        } catch {
          return false;
        }
      });
    expect(exportLine).toBeDefined();
    const exportEvent = JSON.parse(exportLine ?? "") as { type: string; sessionID: string };
    expect(exportEvent.sessionID).toBe("ses_abc123");
  });

  test("result equals extractOpencodeResult applied to the export document", async () => {
    const auditFile = join(tempDir, "audit.jsonl");
    await writeControl(RUN_STDOUT_FILE, '{"type":"step_start","sessionID":"ses_xyz789"}\n');
    await writeControl(EXPORT_STDOUT_FILE, makeExportDoc("  trimmed result  "));

    const runner = createOpencodeRunner();
    const { result } = await runner.runSession("test prompt", tempDir, auditFile);

    // extractOpencodeResult trims the text parts
    expect(result).toBe("trimmed result");
  });

  test("when export exits non-zero, result is empty and no export event is appended", async () => {
    const auditFile = join(tempDir, "audit.jsonl");
    await writeControl(RUN_STDOUT_FILE, '{"type":"step_start","sessionID":"ses_fail123"}\n');
    await writeControl(EXPORT_EXIT_FILE, "1");

    const runner = createOpencodeRunner();
    const { result } = await runner.runSession("test prompt", tempDir, auditFile);

    expect(result).toBe("");

    const content = await readFile(auditFile, "utf8");
    const hasExportEvent = content
      .split("\n")
      .filter((l) => l.trim().length > 0)
      .some((l) => {
        try {
          return (JSON.parse(l) as { type?: string }).type === "opencode-export";
        } catch {
          return false;
        }
      });
    expect(hasExportEvent).toBe(false);
  });

  test("effectiveExitCode is 1 when stream has error events even if raw exit is 0", async () => {
    const auditFile = join(tempDir, "audit.jsonl");
    // Emit an error event without sessionID; raw exit 0 should be overridden to 1
    const errorLine =
      '{"type":"error","error":{"name":"TestError","data":{"message":"something went wrong"}}}\n';
    await writeControl(RUN_STDOUT_FILE, errorLine);

    const runner = createOpencodeRunner();
    const { exitCode, result } = await runner.runSession("test prompt", tempDir, auditFile);

    // resolveEffectiveExitCode(0, 1) === 1
    expect(exitCode).toBe(1);
    // No sessionID → no export → empty result
    expect(result).toBe("");
  });
});
