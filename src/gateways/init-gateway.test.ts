import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInitGateway } from "./init-gateway.ts";

describe("InitGateway", () => {
  const gateway = createInitGateway();
  let tempDir: string;

  afterEach(async () => {
    if (tempDir) {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  async function setup(): Promise<string> {
    tempDir = await mkdtemp(join(tmpdir(), "init-gw-"));
    return tempDir;
  }

  test("exists() returns true for an existing file", async () => {
    const dir = await setup();
    const filePath = join(dir, "file.txt");
    await Bun.write(filePath, "content");
    expect(await gateway.exists(filePath)).toBe(true);
  });

  test("exists() returns false for a missing path", async () => {
    const dir = await setup();
    expect(await gateway.exists(join(dir, "missing.txt"))).toBe(false);
  });

  test("readText() returns file contents as string", async () => {
    const dir = await setup();
    const filePath = join(dir, "hello.txt");
    await Bun.write(filePath, "hello world");
    expect(await gateway.readText(filePath)).toBe("hello world");
  });

  test("writeFile() creates a file with the given content", async () => {
    const dir = await setup();
    const filePath = join(dir, "out.txt");
    await gateway.writeFile(filePath, "written content");
    expect(await Bun.file(filePath).text()).toBe("written content");
  });

  test("mkdirp() creates nested directories that don't yet exist", async () => {
    const dir = await setup();
    const nested = join(dir, "a", "b", "c");
    await gateway.mkdirp(nested);
    const s = await stat(nested);
    expect(s.isDirectory()).toBe(true);
  });

  test("rmrf() recursively removes a directory and its contents", async () => {
    const dir = await setup();
    const nested = join(dir, "to-remove");
    await gateway.mkdirp(nested);
    await gateway.writeFile(join(nested, "file.txt"), "content");
    await gateway.rmrf(nested);
    await expect(stat(nested)).rejects.toThrow();
  });
});
