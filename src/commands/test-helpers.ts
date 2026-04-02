import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ParsedArgs } from "../cli.ts";
import type { ClaimedItem, Item } from "../store.ts";
import { setStoreDir } from "../store.ts";

export function makeParsed(
  command: string,
  positional: string[] = [],
  flags: Record<string, string | boolean> = {},
  arrayFlags: Record<string, string[]> = {},
): ParsedArgs {
  return { command, positional, flags, arrayFlags };
}

export function makeItem(overrides?: Partial<Item>): Item {
  return {
    id: crypto.randomUUID(),
    title: "Test item",
    description: "A test description",
    status: "queued",
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

export function makeClaimedItem(overrides?: Partial<ClaimedItem>): ClaimedItem {
  return {
    id: "aaaaaaaa-0000-0000-0000-000000000000",
    title: "Test task",
    description: "Do something",
    status: "in_progress",
    createdAt: new Date().toISOString(),
    claimedAt: new Date().toISOString(),
    claimedBy: "test-agent",
    claimToken: "tok-1234",
    ...overrides,
  };
}

export function setupTempStoreDir(prefix: string): {
  beforeEach: () => Promise<void>;
  afterEach: () => Promise<void>;
} {
  let tempDir: string;
  return {
    beforeEach: async () => {
      tempDir = await mkdtemp(join(tmpdir(), prefix));
      setStoreDir(tempDir);
    },
    afterEach: async () => {
      await rm(tempDir, { recursive: true });
    },
  };
}
