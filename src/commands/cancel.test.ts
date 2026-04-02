import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { addItem, saveItems } from "../store.ts";
import { cancelCommand } from "./cancel.ts";
import { makeItem, makeParsed, setupTempStoreDir } from "./test-helpers.ts";

describe("cancelCommand", () => {
  const storeDir = setupTempStoreDir("hopper-cancel-test-");

  beforeEach(storeDir.beforeEach);
  afterEach(storeDir.afterEach);

  test("returns error when no id is provided", async () => {
    const result = await cancelCommand(makeParsed("cancel", []));
    expect(result.status).toBe("error");
    if (result.status === "error") {
      expect(result.message).toBe("Usage: hopper cancel <item-id>");
    }
  });

  test("returns success with humanOutput on successful cancel", async () => {
    const item = makeItem();
    await addItem(item);

    const result = await cancelCommand(makeParsed("cancel", [item.id]));

    expect(result.status).toBe("success");
    if (result.status === "success") {
      expect(result.humanOutput).toBe(`Cancelled: ${item.title}`);
      expect(result.warnings).toBeUndefined();
    }
  });

  test("includes recurrence stopped note when item has recurrence", async () => {
    const item = makeItem({
      recurrence: { interval: "1d", intervalMs: 86400000 },
    });
    await addItem(item);

    const result = await cancelCommand(makeParsed("cancel", [item.id]));

    expect(result.status).toBe("success");
    if (result.status === "success") {
      expect(result.humanOutput).toBe(`Cancelled: ${item.title} (recurrence stopped)`);
    }
  });

  test("includes warning when blocked dependents exist", async () => {
    const dep = makeItem({ id: "aaaaaaaa-0000-0000-0000-000000000001" });
    const blocked = makeItem({
      status: "blocked",
      dependsOn: [dep.id],
    });
    await saveItems([dep, blocked]);

    const result = await cancelCommand(makeParsed("cancel", [dep.id]));

    expect(result.status).toBe("success");
    if (result.status === "success") {
      expect(result.warnings).toEqual([
        "Warning: 1 item(s) depend on this item and will remain blocked.",
      ]);
    }
  });

  test("propagates error from store when item cannot be cancelled", async () => {
    const item = makeItem({ status: "in_progress" });
    await addItem(item);

    await expect(cancelCommand(makeParsed("cancel", [item.id]))).rejects.toThrow();
  });
});
