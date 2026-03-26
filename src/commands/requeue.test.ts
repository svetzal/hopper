import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ParsedArgs } from "../cli.ts";
import type { Item } from "../store.ts";
import { addItem, claimNextItem, setStoreDir } from "../store.ts";
import { requeueCommand } from "./requeue.ts";

function makeParsed(
  positional: string[] = [],
  flags: Record<string, string | boolean> = {},
): ParsedArgs {
  return { command: "requeue", positional, flags, arrayFlags: {} };
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

async function addAndClaimId(): Promise<string> {
  await addItem(makeItem());
  const claimed = await claimNextItem();
  if (!claimed) throw new Error("Failed to claim item in test setup");
  return claimed.id;
}

describe("requeueCommand", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "hopper-requeue-test-"));
    setStoreDir(tempDir);
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true });
  });

  test("returns error when no id is provided", async () => {
    const result = await requeueCommand(makeParsed([]));

    expect(result.status).toBe("error");
    if (result.status === "error") {
      expect(result.message).toContain("Usage:");
    }
  });

  test("returns error when --reason is missing", async () => {
    const result = await requeueCommand(makeParsed(["some-id"]));

    expect(result.status).toBe("error");
    if (result.status === "error") {
      expect(result.message).toBe("--reason is required");
    }
  });

  test("returns error when --reason is boolean true", async () => {
    const result = await requeueCommand(makeParsed(["some-id"], { reason: true }));

    expect(result.status).toBe("error");
    if (result.status === "error") {
      expect(result.message).toBe("--reason is required");
    }
  });

  test("returns success with requeued item", async () => {
    const id = await addAndClaimId();

    const result = await requeueCommand(makeParsed([id], { reason: "not ready" }));

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

    const result = await requeueCommand(makeParsed([id], { reason: "blocked", agent: "my-bot" }));

    expect(result.status).toBe("success");
    if (result.status === "success") {
      const data = result.data as Item;
      expect(data.requeuedBy).toBe("my-bot");
    }
  });
});
