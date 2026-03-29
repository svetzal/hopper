import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFsGateway } from "./fs-gateway.ts";

describe("FsGateway", () => {
  const gateway = createFsGateway();
  let tempDir: string;

  afterEach(async () => {
    if (tempDir) {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  async function setup(): Promise<string> {
    tempDir = await mkdtemp(join(tmpdir(), "fs-gw-"));
    return tempDir;
  }

  test("ensureDir creates a nested directory path", async () => {
    const base = await setup();
    const nested = join(base, "a", "b", "c");
    await gateway.ensureDir(nested);
    const s = await stat(nested);
    expect(s.isDirectory()).toBe(true);
  });

  test("ensureDir succeeds silently when directory already exists", async () => {
    const base = await setup();
    await gateway.ensureDir(base);
    const s = await stat(base);
    expect(s.isDirectory()).toBe(true);
  });

  test("writeFile creates a file with expected contents", async () => {
    const base = await setup();
    const filePath = join(base, "hello.txt");
    await gateway.writeFile(filePath, "hello world");
    const content = await Bun.file(filePath).text();
    expect(content).toBe("hello world");
  });
});
