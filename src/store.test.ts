import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import {
  loadItems,
  saveItems,
  addItem,
  setStoreDir,
  getStorePath,
  claimNextItem,
  completeItem,
  requeueItem,
} from "./store.ts";
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
      status: "queued",
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

  // Migration tests
  test("loadItems applies status queued to legacy items missing status", async () => {
    const legacy = [
      { id: "1", title: "Old", description: "desc", createdAt: "2025-01-01T00:00:00Z" },
    ];
    await Bun.write(getStorePath(), JSON.stringify(legacy));

    const loaded = await loadItems();
    expect(loaded[0]!.status).toBe("queued");
  });

  // claimNextItem tests
  test("claimNextItem claims oldest queued item (FIFO)", async () => {
    const older = makeItem({ title: "Older", createdAt: "2025-01-01T00:00:00Z" });
    const newer = makeItem({ title: "Newer", createdAt: "2025-06-01T00:00:00Z" });
    await saveItems([newer, older]);

    const claimed = await claimNextItem("test-agent");
    expect(claimed).not.toBeNull();
    expect(claimed!.title).toBe("Older");
    expect(claimed!.status).toBe("in_progress");
    expect(claimed!.claimedBy).toBe("test-agent");
    expect(claimed!.claimToken).toBeDefined();
    expect(claimed!.claimedAt).toBeDefined();
  });

  test("claimNextItem returns null when queue is empty", async () => {
    const result = await claimNextItem();
    expect(result).toBeNull();
  });

  test("claimNextItem skips in_progress items", async () => {
    const inProgress = makeItem({
      title: "In Progress",
      status: "in_progress",
      createdAt: "2025-01-01T00:00:00Z",
    });
    const queued = makeItem({
      title: "Queued",
      status: "queued",
      createdAt: "2025-06-01T00:00:00Z",
    });
    await saveItems([inProgress, queued]);

    const claimed = await claimNextItem();
    expect(claimed!.title).toBe("Queued");
  });

  test("claimNextItem populates all claim fields", async () => {
    await saveItems([makeItem()]);

    const claimed = await claimNextItem("my-agent");
    expect(claimed!.status).toBe("in_progress");
    expect(claimed!.claimedAt).toBeTruthy();
    expect(claimed!.claimedBy).toBe("my-agent");
    expect(claimed!.claimToken).toBeTruthy();
  });

  // completeItem tests
  test("completeItem completes with valid token", async () => {
    await saveItems([makeItem()]);
    const claimed = await claimNextItem("agent");
    const token = claimed!.claimToken!;

    const completed = await completeItem(token, "agent");
    expect(completed.status).toBe("completed");
    expect(completed.completedAt).toBeDefined();
    expect(completed.completedBy).toBe("agent");
    expect(completed.claimToken).toBeUndefined();
  });

  test("completeItem throws on invalid token", async () => {
    await saveItems([makeItem()]);
    await claimNextItem();

    await expect(completeItem("bad-token")).rejects.toThrow("No in-progress item found");
  });

  test("completeItem stores result when provided", async () => {
    await saveItems([makeItem()]);
    const claimed = await claimNextItem("agent");
    const token = claimed!.claimToken!;

    const completed = await completeItem(token, "agent", "Fixed the login bug");
    expect(completed.result).toBe("Fixed the login bug");

    const items = await loadItems();
    expect(items[0]!.result).toBe("Fixed the login bug");
  });

  test("completeItem leaves result undefined when not provided", async () => {
    await saveItems([makeItem()]);
    const claimed = await claimNextItem("agent");
    const completed = await completeItem(claimed!.claimToken!, "agent");
    expect(completed.result).toBeUndefined();
  });

  test("completeItem clears claim token after completion", async () => {
    await saveItems([makeItem()]);
    const claimed = await claimNextItem();
    await completeItem(claimed!.claimToken!);

    const items = await loadItems();
    expect(items[0]!.claimToken).toBeUndefined();
  });

  test("completeItem sets timestamps", async () => {
    await saveItems([makeItem()]);
    const claimed = await claimNextItem();
    const completed = await completeItem(claimed!.claimToken!);

    expect(completed.completedAt).toBeTruthy();
    expect(new Date(completed.completedAt!).getTime()).toBeGreaterThan(0);
  });

  // requeueItem tests
  test("requeueItem resets to queued", async () => {
    const item = makeItem();
    await saveItems([item]);
    const claimed = await claimNextItem();
    const requeued = await requeueItem(claimed!.id, "needs more info");

    expect(requeued.status).toBe("queued");
    expect(requeued.requeueReason).toBe("needs more info");
  });

  test("requeueItem preserves createdAt", async () => {
    const originalCreatedAt = "2025-01-01T00:00:00Z";
    const item = makeItem({ createdAt: originalCreatedAt });
    await saveItems([item]);
    await claimNextItem();
    const requeued = await requeueItem(item.id, "reason");

    expect(requeued.createdAt).toBe(originalCreatedAt);
  });

  test("requeueItem clears claim fields", async () => {
    await saveItems([makeItem()]);
    const claimed = await claimNextItem("agent");
    const requeued = await requeueItem(claimed!.id, "blocked");

    expect(requeued.claimedAt).toBeUndefined();
    expect(requeued.claimedBy).toBeUndefined();
    expect(requeued.claimToken).toBeUndefined();
  });

  test("requeueItem rejects non-in_progress items", async () => {
    const item = makeItem({ status: "queued" });
    await saveItems([item]);

    await expect(requeueItem(item.id, "reason")).rejects.toThrow("not in progress");
  });
});
