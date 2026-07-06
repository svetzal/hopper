import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { addItem } from "../store.ts";
import { makeItem, makeParsed, setupTempStoreDir } from "../test-helpers.ts";
import { editCommand } from "./edit.ts";

describe("editCommand", () => {
  const storeDir = setupTempStoreDir("hopper-edit-test-");

  beforeEach(storeDir.beforeEach);
  afterEach(storeDir.afterEach);

  test("returns error when id is missing", async () => {
    const result = await editCommand(makeParsed("edit", []));

    expect(result.status).toBe("error");
    if (result.status === "error") {
      expect(result.message).toContain("Usage:");
    }
  });

  test("returns error when --priority is missing", async () => {
    const result = await editCommand(makeParsed("edit", ["some-id"]));

    expect(result.status).toBe("error");
    if (result.status === "error") {
      expect(result.message).toContain("--priority");
    }
  });

  test("returns error for invalid priority level", async () => {
    const item = makeItem();
    await addItem(item);

    const result = await editCommand(makeParsed("edit", [item.id], { priority: "invalid" }));

    expect(result.status).toBe("error");
    if (result.status === "error") {
      expect(result.message).toBeTruthy();
    }
  });

  test("returns success with updated item", async () => {
    const item = makeItem({ priority: "normal" });
    await addItem(item);

    const result = await editCommand(makeParsed("edit", [item.id], { priority: "high" }));

    expect(result.status).toBe("success");
    if (result.status === "success") {
      expect(result.data.priority).toBe("high");
      expect(result.humanOutput).toContain("normal");
      expect(result.humanOutput).toContain("high");
    }
  });
});
