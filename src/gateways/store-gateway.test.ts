import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeItem } from "../test-helpers.ts";
import { createStoreGateway } from "./store-gateway.ts";

describe("StoreGateway", () => {
  let tempDir: string;

  afterEach(async () => {
    if (tempDir) {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  async function setup() {
    tempDir = await mkdtemp(join(tmpdir(), "store-gw-"));
    return createStoreGateway(tempDir);
  }

  test("load returns [] when file does not exist", async () => {
    const gateway = await setup();
    const items = await gateway.load();
    expect(items).toEqual([]);
  });

  test("load returns [] when file contains invalid JSON", async () => {
    const gateway = await setup();
    await Bun.write(join(tempDir, "items.json"), "{ not valid json }}}");
    const items = await gateway.load();
    expect(items).toEqual([]);
  });

  test("save then load round-trips an array of items", async () => {
    const gateway = await setup();
    const items = [
      makeItem({ id: "aaa-1", title: "First" }),
      makeItem({ id: "bbb-2", title: "Second", status: "completed" }),
    ];
    await gateway.save(items);
    const loaded = await gateway.load();
    expect(loaded).toHaveLength(2);
    expect(loaded[0]?.id).toBe("aaa-1");
    expect(loaded[1]?.status).toBe("completed");
  });

  test("save creates the directory if it does not exist", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "store-gw-"));
    const nestedDir = join(tempDir, "deeply", "nested");
    const gateway = createStoreGateway(nestedDir);
    const items = [makeItem()];
    await gateway.save(items);
    const loaded = await gateway.load();
    expect(loaded).toHaveLength(1);
  });

  test("load applies ensureDefaults: items missing status get queued", async () => {
    const gateway = await setup();
    const rawItem = {
      id: "legacy-id",
      title: "Legacy",
      description: "old item",
      createdAt: "2024-01-01T00:00:00Z",
    };
    await Bun.write(join(tempDir, "items.json"), JSON.stringify([rawItem]));
    const loaded = await gateway.load();
    expect(loaded[0]?.status).toBe("queued");
  });
});
