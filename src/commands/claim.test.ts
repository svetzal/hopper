import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ParsedArgs } from "../cli.ts";
import type { Item } from "../store.ts";
import { addItem, setStoreDir } from "../store.ts";
import { claimCommand } from "./claim.ts";

function makeParsed(flags: Record<string, string | boolean> = {}): ParsedArgs {
  return { command: "claim", positional: [], flags, arrayFlags: {} };
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

describe("claimCommand", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "hopper-claim-test-"));
    setStoreDir(tempDir);
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true });
  });

  test("returns error when no queued items exist", async () => {
    const result = await claimCommand(makeParsed());

    expect(result.status).toBe("error");
    if (result.status === "error") {
      expect(result.message).toBe("No queued items available.");
    }
  });

  test("returns success with claimed item and token in humanOutput", async () => {
    const item = makeItem();
    await addItem(item);

    const result = await claimCommand(makeParsed());

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

    const result = await claimCommand(makeParsed({ agent: "my-agent" }));

    expect(result.status).toBe("success");
    if (result.status === "success") {
      const data = result.data as Item;
      expect(data.claimedBy).toBe("my-agent");
    }
  });

  test("ignores boolean agent flag", async () => {
    const item = makeItem();
    await addItem(item);

    const result = await claimCommand(makeParsed({ agent: true }));

    expect(result.status).toBe("success");
    if (result.status === "success") {
      const data = result.data as Item;
      expect(data.claimedBy).toBeUndefined();
    }
  });
});
