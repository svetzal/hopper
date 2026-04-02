import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Item } from "../store.ts";
import { addItem } from "../store.ts";
import { reprioritizeCommand } from "./reprioritize.ts";
import { makeItem, makeParsed, setupTempStoreDir } from "./test-helpers.ts";

describe("reprioritizeCommand", () => {
  const storeDir = setupTempStoreDir("hopper-reprioritize-test-");

  beforeEach(storeDir.beforeEach);
  afterEach(storeDir.afterEach);

  test("returns error when id is missing", async () => {
    const result = await reprioritizeCommand(makeParsed("reprioritize", []));

    expect(result.status).toBe("error");
    if (result.status === "error") {
      expect(result.message).toContain("Usage:");
    }
  });

  test("returns error when priority level is missing", async () => {
    const result = await reprioritizeCommand(makeParsed("reprioritize", ["some-id"]));

    expect(result.status).toBe("error");
    if (result.status === "error") {
      expect(result.message).toContain("Usage:");
    }
  });

  test("returns error for invalid priority level", async () => {
    const item = makeItem();
    await addItem(item);

    const result = await reprioritizeCommand(makeParsed("reprioritize", [item.id, "invalid"]));

    expect(result.status).toBe("error");
    if (result.status === "error") {
      expect(result.message).toBeTruthy();
    }
  });

  test("returns success with updated item", async () => {
    const item = makeItem({ priority: "normal" });
    await addItem(item);

    const result = await reprioritizeCommand(makeParsed("reprioritize", [item.id, "high"]));

    expect(result.status).toBe("success");
    if (result.status === "success") {
      const data = result.data as Item;
      expect(data.priority).toBe("high");
      expect(result.humanOutput).toContain("normal");
      expect(result.humanOutput).toContain("high");
    }
  });
});
