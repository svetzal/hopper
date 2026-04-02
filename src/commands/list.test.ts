import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Item } from "../store.ts";
import { addItem, saveItems } from "../store.ts";
import { listCommand } from "./list.ts";
import { makeItem, makeParsed, setupTempStoreDir } from "./test-helpers.ts";

describe("listCommand", () => {
  const storeDir = setupTempStoreDir("hopper-list-test-");

  beforeEach(storeDir.beforeEach);
  afterEach(storeDir.afterEach);

  test("returns success with empty queue message when no items", async () => {
    const result = await listCommand(makeParsed("list"));

    expect(result.status).toBe("success");
    if (result.status === "success") {
      expect(result.humanOutput).toBe("Queue is empty.");
      expect(result.data).toEqual([]);
    }
  });

  test("returns success with items in data", async () => {
    await addItem(makeItem({ title: "Task one" }));
    await addItem(makeItem({ title: "Task two" }));

    const result = await listCommand(makeParsed("list"));

    expect(result.status).toBe("success");
    if (result.status === "success") {
      const data = result.data as Item[];
      expect(data).toHaveLength(2);
    }
  });

  test("filters to completed items with --completed flag", async () => {
    await addItem(makeItem({ status: "queued" }));
    await addItem(makeItem({ status: "completed", completedAt: new Date().toISOString() }));

    const result = await listCommand(makeParsed("list", [], { completed: true }));

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

    const result = await listCommand(makeParsed("list", [], { all: true }));

    expect(result.status).toBe("success");
    if (result.status === "success") {
      const data = result.data as Item[];
      expect(data).toHaveLength(2);
    }
  });

  test("returns error for invalid priority filter", async () => {
    await addItem(makeItem());

    const result = await listCommand(makeParsed("list", [], { priority: "invalid" }));

    expect(result.status).toBe("error");
  });

  test("filters by tag", async () => {
    await addItem(makeItem({ tags: ["frontend"] }));
    await addItem(makeItem({ tags: ["backend"] }));

    const result = await listCommand(makeParsed("list", [], {}, { tag: ["frontend"] }));

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

    const result = await listCommand(makeParsed("list"));

    expect(result.status).toBe("success");
    if (result.status === "success") {
      const data = result.data as Item[];
      expect(data).toHaveLength(1);
    }
  });
});
