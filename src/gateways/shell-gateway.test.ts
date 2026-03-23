import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createShellGateway } from "./shell-gateway.ts";

describe("ShellGateway", () => {
  const gateway = createShellGateway();
  let tempDir: string;

  afterEach(async () => {
    if (tempDir) {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  async function setup() {
    tempDir = await mkdtemp(join(tmpdir(), "shell-gw-"));
    return tempDir;
  }

  test("captures stdout and returns exit code 0", async () => {
    const dir = await setup();
    const auditFile = join(dir, "audit.log");

    const { exitCode, result } = await gateway.runCommand("echo hello world", dir, auditFile);

    expect(exitCode).toBe(0);
    expect(result).toBe("hello world");

    const auditContent = await Bun.file(auditFile).text();
    expect(auditContent).toContain("hello world");
  });

  test("returns non-zero exit code on failure", async () => {
    const dir = await setup();
    const auditFile = join(dir, "audit.log");

    const { exitCode } = await gateway.runCommand("exit 42", dir, auditFile);

    expect(exitCode).toBe(42);
  });

  test("captures stderr in audit file", async () => {
    const dir = await setup();
    const auditFile = join(dir, "audit.log");

    await gateway.runCommand("echo error-output >&2", dir, auditFile);

    const auditContent = await Bun.file(auditFile).text();
    expect(auditContent).toContain("error-output");
  });

  test("runs command in specified working directory", async () => {
    const dir = await setup();
    const auditFile = join(dir, "audit.log");

    const { result } = await gateway.runCommand("pwd", dir, auditFile);

    // realpath because macOS /tmp -> /private/tmp
    const { stdout } = Bun.spawnSync(["realpath", dir]);
    const realDir = new TextDecoder().decode(stdout).trim();
    const { stdout: resultReal } = Bun.spawnSync(["realpath", result]);
    const realResult = new TextDecoder().decode(resultReal).trim();

    expect(realResult).toBe(realDir);
  });
});
