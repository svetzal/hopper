import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import { loadItems, saveItems, addItem, setStoreDir, getStorePath } from "./store.ts";
import type { Item } from "./store.ts";

describe("store", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "hopper-test-"));
    setStoreDir(tempDir);
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true });
  });

  function makeItem(overrides?: Partial<Item>): Item {
    return {
      id: crypto.randomUUID(),
      title: "Test item",
      description: "A test description",
      createdAt: new Date().toISOString(),
      ...overrides,
    };
  }

  test("loadItems returns empty array when no file exists", async () => {
    const items = await loadItems();
    expect(items).toEqual([]);
  });

  test("saveItems creates file and loadItems reads it back", async () => {
    const items = [makeItem({ title: "First" }), makeItem({ title: "Second" })];
    await saveItems(items);

    const loaded = await loadItems();
    expect(loaded).toHaveLength(2);
    expect(loaded[0]!.title).toBe("First");
    expect(loaded[1]!.title).toBe("Second");
  });

  test("saveItems creates directory if missing", async () => {
    const nestedDir = join(tempDir, "nested", "dir");
    setStoreDir(nestedDir);

    await saveItems([makeItem()]);
    const loaded = await loadItems();
    expect(loaded).toHaveLength(1);
  });

  test("addItem prepends to existing items", async () => {
    await saveItems([makeItem({ title: "Existing" })]);
    await addItem(makeItem({ title: "New" }));

    const loaded = await loadItems();
    expect(loaded).toHaveLength(2);
    expect(loaded[0]!.title).toBe("New");
    expect(loaded[1]!.title).toBe("Existing");
  });

  test("addItem works when no file exists yet", async () => {
    await addItem(makeItem({ title: "First ever" }));

    const loaded = await loadItems();
    expect(loaded).toHaveLength(1);
    expect(loaded[0]!.title).toBe("First ever");
  });

  test("getStorePath returns path inside store dir", () => {
    expect(getStorePath()).toBe(join(tempDir, "items.json"));
  });
});
