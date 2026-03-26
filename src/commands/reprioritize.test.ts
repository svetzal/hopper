import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ParsedArgs } from "../cli.ts";
import type { Item } from "../store.ts";
import { addItem, setStoreDir } from "../store.ts";
import { reprioritizeCommand } from "./reprioritize.ts";

function makeParsed(
  positional: string[] = [],
  flags: Record<string, string | boolean> = {},
): ParsedArgs {
  return { command: "reprioritize", positional, flags, arrayFlags: {} };
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

describe("reprioritizeCommand", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "hopper-reprioritize-test-"));
    setStoreDir(tempDir);
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true });
  });

  test("returns error when id is missing", async () => {
    const result = await reprioritizeCommand(makeParsed([]));

    expect(result.status).toBe("error");
    if (result.status === "error") {
      expect(result.message).toContain("Usage:");
    }
  });

  test("returns error when priority level is missing", async () => {
    const result = await reprioritizeCommand(makeParsed(["some-id"]));

    expect(result.status).toBe("error");
    if (result.status === "error") {
      expect(result.message).toContain("Usage:");
    }
  });

  test("returns error for invalid priority level", async () => {
    const item = makeItem();
    await addItem(item);

    const result = await reprioritizeCommand(makeParsed([item.id, "invalid"]));

    expect(result.status).toBe("error");
    if (result.status === "error") {
      expect(result.message).toBeTruthy();
    }
  });

  test("returns success with updated item", async () => {
    const item = makeItem({ priority: "normal" });
    await addItem(item);

    const result = await reprioritizeCommand(makeParsed([item.id, "high"]));

    expect(result.status).toBe("success");
    if (result.status === "success") {
      const data = result.data as Item;
      expect(data.priority).toBe("high");
      expect(result.humanOutput).toContain("normal");
      expect(result.humanOutput).toContain("high");
    }
  });
});
