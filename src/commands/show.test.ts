import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Item } from "../store.ts";
import { addItem } from "../store.ts";
import { showCommand } from "./show.ts";
import { makeItem, makeParsed, setupTempStoreDir } from "./test-helpers.ts";

describe("showCommand", () => {
  const storeDir = setupTempStoreDir("hopper-show-test-");

  beforeEach(storeDir.beforeEach);
  afterEach(storeDir.afterEach);

  test("returns error when no id is provided", async () => {
    const result = await showCommand(makeParsed("show", []));

    expect(result.status).toBe("error");
    if (result.status === "error") {
      expect(result.message).toBe("Usage: hopper show <id>");
    }
  });

  test("returns success with item detail in humanOutput", async () => {
    const item = makeItem();
    await addItem(item);

    const result = await showCommand(makeParsed("show", [item.id]));

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

    const result = await showCommand(makeParsed("show", [item.id]));

    expect(result.status).toBe("success");
    if (result.status === "success") {
      const data = result.data as Item;
      expect(data.title).toBe("Specific task");
    }
  });

  test("returns error when id not found", async () => {
    const result = await showCommand(makeParsed("show", ["nonexistent"]));
    expect(result.status).toBe("error");
    if (result.status === "error") {
      expect(result.message).toBeTruthy();
    }
  });
});
