import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadJsonFile, saveJsonFile } from "./json-file.ts";

describe("json-file", () => {
  let tempDir: string;

  afterEach(async () => {
    if (tempDir) {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  async function setup(): Promise<string> {
    tempDir = await mkdtemp(join(tmpdir(), "json-file-"));
    return tempDir;
  }

  describe("loadJsonFile", () => {
    test("returns [] when file does not exist", async () => {
      const dir = await setup();
      const result = await loadJsonFile<unknown>(join(dir, "nonexistent.json"));
      expect(result).toEqual([]);
    });

    test("parses a valid JSON array file and returns contents", async () => {
      const dir = await setup();
      const filePath = join(dir, "items.json");
      await Bun.write(filePath, JSON.stringify([{ id: "1" }, { id: "2" }]));
      const result = await loadJsonFile<{ id: string }>(filePath);
      expect(result).toEqual([{ id: "1" }, { id: "2" }]);
    });

    test("applies transform callback to raw elements", async () => {
      const dir = await setup();
      const filePath = join(dir, "items.json");
      await Bun.write(filePath, JSON.stringify([{ val: 1 }, { val: 2 }]));
      const result = await loadJsonFile<{ val: number; doubled: number }>(filePath, (raw) =>
        (raw as { val: number }[]).map((x) => ({ ...x, doubled: x.val * 2 })),
      );
      expect(result).toEqual([
        { val: 1, doubled: 2 },
        { val: 2, doubled: 4 },
      ]);
    });

    test("returns [] for corrupted/invalid JSON", async () => {
      const dir = await setup();
      const filePath = join(dir, "bad.json");
      await Bun.write(filePath, "not valid json {{{{");
      const result = await loadJsonFile<unknown>(filePath);
      expect(result).toEqual([]);
    });
  });

  describe("saveJsonFile", () => {
    test("creates parent directory and writes 2-space indented JSON with trailing newline", async () => {
      const dir = await setup();
      const subDir = join(dir, "nested", "sub");
      const filePath = join(subDir, "data.json");
      const data = [{ id: "a" }, { id: "b" }];
      await saveJsonFile(filePath, subDir, data);
      const content = await Bun.file(filePath).text();
      expect(content).toBe(`${JSON.stringify(data, null, 2)}\n`);
    });

    test("overwrites an existing file with new content", async () => {
      const dir = await setup();
      const filePath = join(dir, "data.json");
      await Bun.write(filePath, '["old"]');
      await saveJsonFile(filePath, dir, [{ id: "new" }]);
      const content = await Bun.file(filePath).text();
      expect(content).toBe(`${JSON.stringify([{ id: "new" }], null, 2)}\n`);
    });
  });
});
