import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Item } from "../store.ts";
import { addItem, claimNextItem } from "../store.ts";
import { makeItem, makeParsed, setupTempStoreDir } from "../test-helpers.ts";
import { requeueCommand } from "./requeue.ts";

async function addAndClaimId(): Promise<string> {
  await addItem(makeItem());
  const claimed = await claimNextItem();
  if (!claimed) throw new Error("Failed to claim item in test setup");
  return claimed.id;
}

describe("requeueCommand", () => {
  const storeDir = setupTempStoreDir("hopper-requeue-test-");

  beforeEach(storeDir.beforeEach);
  afterEach(storeDir.afterEach);

  test("returns error when no id is provided", async () => {
    const result = await requeueCommand(makeParsed("requeue", []));

    expect(result.status).toBe("error");
    if (result.status === "error") {
      expect(result.message).toContain("Usage:");
    }
  });

  test("returns error when --reason is missing", async () => {
    const result = await requeueCommand(makeParsed("requeue", ["some-id"]));

    expect(result.status).toBe("error");
    if (result.status === "error") {
      expect(result.message).toBe("--reason is required");
    }
  });

  test("returns error when --reason is boolean true", async () => {
    const result = await requeueCommand(makeParsed("requeue", ["some-id"], { reason: true }));

    expect(result.status).toBe("error");
    if (result.status === "error") {
      expect(result.message).toBe("--reason is required");
    }
  });

  test("returns success with requeued item", async () => {
    const id = await addAndClaimId();

    const result = await requeueCommand(makeParsed("requeue", [id], { reason: "not ready" }));

    expect(result.status).toBe("success");
    if (result.status === "success") {
      const data = result.data as Item;
      expect(data.status).toBe("queued");
      expect(data.requeueReason).toBe("not ready");
      expect(result.humanOutput).toContain("Requeued:");
    }
  });

  test("passes agent flag through", async () => {
    const id = await addAndClaimId();

    const result = await requeueCommand(
      makeParsed("requeue", [id], { reason: "blocked", agent: "my-bot" }),
    );

    expect(result.status).toBe("success");
    if (result.status === "success") {
      const data = result.data as Item;
      expect(data.requeuedBy).toBe("my-bot");
    }
  });
});
