import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ParsedArgs } from "../cli.ts";
import type { Item } from "../store.ts";
import { addItem, saveItems, setStoreDir } from "../store.ts";
import { listCommand } from "./list.ts";

function makeParsed(
  flags: Record<string, string | boolean> = {},
  arrayFlags: Record<string, string[]> = {},
): ParsedArgs {
  return { command: "list", positional: [], flags, arrayFlags };
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

describe("listCommand", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "hopper-list-test-"));
    setStoreDir(tempDir);
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true });
  });

  test("returns success with empty queue message when no items", async () => {
    const result = await listCommand(makeParsed());

    expect(result.status).toBe("success");
    if (result.status === "success") {
      expect(result.humanOutput).toBe("Queue is empty.");
      expect(result.data).toEqual([]);
    }
  });

  test("returns success with items in data", async () => {
    await addItem(makeItem({ title: "Task one" }));
    await addItem(makeItem({ title: "Task two" }));

    const result = await listCommand(makeParsed());

    expect(result.status).toBe("success");
    if (result.status === "success") {
      const data = result.data as Item[];
      expect(data).toHaveLength(2);
    }
  });

  test("filters to completed items with --completed flag", async () => {
    await addItem(makeItem({ status: "queued" }));
    await addItem(makeItem({ status: "completed", completedAt: new Date().toISOString() }));

    const result = await listCommand(makeParsed({ completed: true }));

    expect(result.status).toBe("success");
    if (result.status === "success") {
      const data = result.data as Item[];
      expect(data).toHaveLength(1);
      expect(data[0]?.status).toBe("completed");
    }
  });

  test("filters to all items with --all flag", async () => {
    await addItem(makeItem({ status: "queued" }));
    await addItem(makeItem({ status: "completed", completedAt: new Date().toISOString() }));

    const result = await listCommand(makeParsed({ all: true }));

    expect(result.status).toBe("success");
    if (result.status === "success") {
      const data = result.data as Item[];
      expect(data).toHaveLength(2);
    }
  });

  test("returns error for invalid priority filter", async () => {
    await addItem(makeItem());

    const result = await listCommand(makeParsed({ priority: "invalid" }));

    expect(result.status).toBe("error");
  });

  test("filters by tag", async () => {
    await addItem(makeItem({ tags: ["frontend"] }));
    await addItem(makeItem({ tags: ["backend"] }));

    const result = await listCommand(makeParsed({}, { tag: ["frontend"] }));

    expect(result.status).toBe("success");
    if (result.status === "success") {
      const data = result.data as Item[];
      expect(data).toHaveLength(1);
      expect(data[0]?.tags).toContain("frontend");
    }
  });

  test("does not include cancelled items in default view", async () => {
    await saveItems([
      makeItem({ status: "queued" }),
      makeItem({ status: "cancelled", cancelledAt: new Date().toISOString() }),
    ]);

    const result = await listCommand(makeParsed());

    expect(result.status).toBe("success");
    if (result.status === "success") {
      const data = result.data as Item[];
      expect(data).toHaveLength(1);
    }
  });
});
