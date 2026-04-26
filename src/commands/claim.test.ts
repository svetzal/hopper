import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Item } from "../store.ts";
import { addItem } from "../store.ts";
import { makeItem, makeParsed, setupTempStoreDir } from "../test-helpers.ts";
import { claimCommand } from "./claim.ts";

describe("claimCommand", () => {
  const storeDir = setupTempStoreDir("hopper-claim-test-");

  beforeEach(storeDir.beforeEach);
  afterEach(storeDir.afterEach);

  test("returns error when no queued items exist", async () => {
    const result = await claimCommand(makeParsed("claim"));

    expect(result.status).toBe("error");
    if (result.status === "error") {
      expect(result.message).toBe("No queued items available.");
    }
  });

  test("returns success with claimed item and token in humanOutput", async () => {
    const item = makeItem();
    await addItem(item);

    const result = await claimCommand(makeParsed("claim"));

    expect(result.status).toBe("success");
    if (result.status === "success") {
      const data = result.data as Item;
      expect(data.status).toBe("in_progress");
      expect(result.humanOutput).toContain("Claimed:");
      expect(result.humanOutput).toContain("Token:");
    }
  });

  test("passes agent name to claimNextItem", async () => {
    const item = makeItem();
    await addItem(item);

    const result = await claimCommand(makeParsed("claim", [], { agent: "my-agent" }));

    expect(result.status).toBe("success");
    if (result.status === "success") {
      const data = result.data as Item;
      expect(data.claimedBy).toBe("my-agent");
    }
  });

  test("ignores boolean agent flag", async () => {
    const item = makeItem();
    await addItem(item);

    const result = await claimCommand(makeParsed("claim", [], { agent: true }));

    expect(result.status).toBe("success");
    if (result.status === "success") {
      const data = result.data as Item;
      expect(data.claimedBy).toBeUndefined();
    }
  });
});
