import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ParsedArgs } from "../cli.ts";
import type { Item } from "../store.ts";
import { addItem, setStoreDir } from "../store.ts";
import { showCommand } from "./show.ts";

function makeParsed(
  positional: string[] = [],
  flags: Record<string, string | boolean> = {},
): ParsedArgs {
  return { command: "show", positional, flags, arrayFlags: {} };
}

function makeItem(overrides?: Partial<Item>): Item {
  return {
    id: crypto.randomUUID(),
    title: "Test item",
    description: "A test description",
    status: "queued",
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

describe("showCommand", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "hopper-show-test-"));
    setStoreDir(tempDir);
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true });
  });

  test("returns error when no id is provided", async () => {
    const result = await showCommand(makeParsed([]));

    expect(result.status).toBe("error");
    if (result.status === "error") {
      expect(result.message).toBe("Usage: hopper show <id>");
    }
  });

  test("returns success with item detail in humanOutput", async () => {
    const item = makeItem();
    await addItem(item);

    const result = await showCommand(makeParsed([item.id]));

    expect(result.status).toBe("success");
    if (result.status === "success") {
      expect(result.humanOutput).toContain("Title:");
      expect(result.humanOutput).toContain("Status:");
      expect(result.humanOutput).toContain("Description:");
    }
  });

  test("data contains the full item", async () => {
    const item = makeItem({ title: "Specific task" });
    await addItem(item);

    const result = await showCommand(makeParsed([item.id]));

    expect(result.status).toBe("success");
    if (result.status === "success") {
      const data = result.data as Item;
      expect(data.title).toBe("Specific task");
    }
  });

  test("propagates error when id not found", async () => {
    await expect(showCommand(makeParsed(["nonexistent"]))).rejects.toThrow();
  });
});
