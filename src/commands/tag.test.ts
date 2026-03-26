import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ParsedArgs } from "../cli.ts";
import type { Item } from "../store.ts";
import { addItem, setStoreDir } from "../store.ts";
import { tagCommand, untagCommand } from "./tag.ts";

function makeParsed(
  positional: string[] = [],
  flags: Record<string, string | boolean> = {},
): ParsedArgs {
  return { command: "tag", positional, flags, arrayFlags: {} };
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

describe("tagCommand", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "hopper-tag-test-"));
    setStoreDir(tempDir);
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true });
  });

  test("returns error when no id is provided", async () => {
    const result = await tagCommand(makeParsed([]));

    expect(result.status).toBe("error");
    if (result.status === "error") {
      expect(result.message).toContain("Usage:");
    }
  });

  test("returns error when no tags are provided", async () => {
    const result = await tagCommand(makeParsed(["some-id"]));

    expect(result.status).toBe("error");
    if (result.status === "error") {
      expect(result.message).toContain("Usage:");
    }
  });

  test("returns success with tagged item", async () => {
    const item = makeItem();
    await addItem(item);

    const result = await tagCommand(makeParsed([item.id, "feature", "backend"]));

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
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "hopper-untag-test-"));
    setStoreDir(tempDir);
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true });
  });

  test("returns error when no id is provided", async () => {
    const result = await untagCommand(makeParsed([]));

    expect(result.status).toBe("error");
    if (result.status === "error") {
      expect(result.message).toContain("Usage:");
    }
  });

  test("returns error when no tags are provided", async () => {
    const result = await untagCommand(makeParsed(["some-id"]));

    expect(result.status).toBe("error");
    if (result.status === "error") {
      expect(result.message).toContain("Usage:");
    }
  });

  test("returns success with untagged item", async () => {
    const item = makeItem({ tags: ["feature", "backend"] });
    await addItem(item);

    const result = await untagCommand(makeParsed([item.id, "backend"]));

    expect(result.status).toBe("success");
    if (result.status === "success") {
      const data = result.data as Item;
      expect(data.tags).not.toContain("backend");
      expect(data.tags).toContain("feature");
      expect(result.humanOutput).toContain("Untagged");
    }
  });
});
