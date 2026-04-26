import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Item } from "../store.ts";
import { addItem } from "../store.ts";
import { makeItem, makeParsed, setupTempStoreDir } from "../test-helpers.ts";
import { tagCommand, untagCommand } from "./tag.ts";

describe("tagCommand", () => {
  const storeDir = setupTempStoreDir("hopper-tag-test-");

  beforeEach(storeDir.beforeEach);
  afterEach(storeDir.afterEach);

  test("returns error when no id is provided", async () => {
    const result = await tagCommand(makeParsed("tag", []));

    expect(result.status).toBe("error");
    if (result.status === "error") {
      expect(result.message).toContain("Usage:");
    }
  });

  test("returns error when no tags are provided", async () => {
    const result = await tagCommand(makeParsed("tag", ["some-id"]));

    expect(result.status).toBe("error");
    if (result.status === "error") {
      expect(result.message).toContain("Usage:");
    }
  });

  test("returns success with tagged item", async () => {
    const item = makeItem();
    await addItem(item);

    const result = await tagCommand(makeParsed("tag", [item.id, "feature", "backend"]));

    expect(result.status).toBe("success");
    if (result.status === "success") {
      const data = result.data as Item;
      expect(data.tags).toContain("feature");
      expect(data.tags).toContain("backend");
      expect(result.humanOutput).toContain("Tagged");
    }
  });
});

describe("untagCommand", () => {
  const storeDir = setupTempStoreDir("hopper-untag-test-");

  beforeEach(storeDir.beforeEach);
  afterEach(storeDir.afterEach);

  test("returns error when no id is provided", async () => {
    const result = await untagCommand(makeParsed("untag", []));

    expect(result.status).toBe("error");
    if (result.status === "error") {
      expect(result.message).toContain("Usage:");
    }
  });

  test("returns error when no tags are provided", async () => {
    const result = await untagCommand(makeParsed("untag", ["some-id"]));

    expect(result.status).toBe("error");
    if (result.status === "error") {
      expect(result.message).toContain("Usage:");
    }
  });

  test("returns success with untagged item", async () => {
    const item = makeItem({ tags: ["feature", "backend"] });
    await addItem(item);

    const result = await untagCommand(makeParsed("untag", [item.id, "backend"]));

    expect(result.status).toBe("success");
    if (result.status === "success") {
      const data = result.data as Item;
      expect(data.tags).not.toContain("backend");
      expect(data.tags).toContain("feature");
      expect(result.humanOutput).toContain("Untagged");
    }
  });
});
