import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Item } from "../store.ts";
import { addItem, claimNextItem } from "../store.ts";
import { completeCommand } from "./complete.ts";
import { makeItem, makeParsed, setupTempStoreDir } from "./test-helpers.ts";

async function addAndClaim(overrides?: Partial<Item>): Promise<string> {
  await addItem(makeItem(overrides));
  const claimed = await claimNextItem();
  if (!claimed?.claimToken) throw new Error("Failed to claim item in test setup");
  return claimed.claimToken;
}

describe("completeCommand", () => {
  const storeDir = setupTempStoreDir("hopper-complete-test-");

  beforeEach(storeDir.beforeEach);
  afterEach(storeDir.afterEach);

  test("returns error when no token is provided", async () => {
    const result = await completeCommand(makeParsed("complete", []));

    expect(result.status).toBe("error");
    if (result.status === "error") {
      expect(result.message).toBe("Usage: hopper complete <token>");
    }
  });

  test("returns success with completed item in humanOutput", async () => {
    const token = await addAndClaim();

    const result = await completeCommand(makeParsed("complete", [token]));

    expect(result.status).toBe("success");
    if (result.status === "success") {
      expect(result.humanOutput).toContain("Completed:");
    }
  });

  test("includes recurred item in humanOutput when item recurs", async () => {
    const token = await addAndClaim({ recurrence: { interval: "1d", intervalMs: 86400000 } });

    const result = await completeCommand(makeParsed("complete", [token]));

    expect(result.status).toBe("success");
    if (result.status === "success") {
      expect(result.humanOutput).toContain("Re-queued:");
      const data = result.data as { completed: Item; recurred?: Item };
      expect(data.recurred).toBeDefined();
    }
  });

  test("passes agent and result flags through", async () => {
    const token = await addAndClaim();

    const result = await completeCommand(
      makeParsed("complete", [token], { agent: "bot", result: "All done." }),
    );

    expect(result.status).toBe("success");
    if (result.status === "success") {
      const data = result.data as { completed: Item };
      expect(data.completed.completedBy).toBe("bot");
      expect(data.completed.result).toBe("All done.");
    }
  });

  test("returns error from store when token is invalid", async () => {
    const result = await completeCommand(makeParsed("complete", ["invalid-token"]));
    expect(result.status).toBe("error");
    if (result.status === "error") {
      expect(result.message).toBeTruthy();
    }
  });
});
