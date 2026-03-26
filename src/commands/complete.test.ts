import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ParsedArgs } from "../cli.ts";
import type { Item } from "../store.ts";
import { addItem, claimNextItem, setStoreDir } from "../store.ts";
import { completeCommand } from "./complete.ts";

function makeParsed(
  positional: string[] = [],
  flags: Record<string, string | boolean> = {},
): ParsedArgs {
  return { command: "complete", positional, flags, arrayFlags: {} };
}

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

async function addAndClaim(overrides?: Partial<Item>): Promise<string> {
  await addItem(makeItem(overrides));
  const claimed = await claimNextItem();
  if (!claimed?.claimToken) throw new Error("Failed to claim item in test setup");
  return claimed.claimToken;
}

describe("completeCommand", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "hopper-complete-test-"));
    setStoreDir(tempDir);
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true });
  });

  test("returns error when no token is provided", async () => {
    const result = await completeCommand(makeParsed([]));

    expect(result.status).toBe("error");
    if (result.status === "error") {
      expect(result.message).toBe("Usage: hopper complete <token>");
    }
  });

  test("returns success with completed item in humanOutput", async () => {
    const token = await addAndClaim();

    const result = await completeCommand(makeParsed([token]));

    expect(result.status).toBe("success");
    if (result.status === "success") {
      expect(result.humanOutput).toContain("Completed:");
    }
  });

  test("includes recurred item in humanOutput when item recurs", async () => {
    const token = await addAndClaim({ recurrence: { interval: "1d", intervalMs: 86400000 } });

    const result = await completeCommand(makeParsed([token]));

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
      makeParsed([token], { agent: "bot", result: "All done." }),
    );

    expect(result.status).toBe("success");
    if (result.status === "success") {
      const data = result.data as { completed: Item };
      expect(data.completed.completedBy).toBe("bot");
      expect(data.completed.result).toBe("All done.");
    }
  });

  test("propagates error from store when token is invalid", async () => {
    await expect(completeCommand(makeParsed(["invalid-token"]))).rejects.toThrow();
  });
});
