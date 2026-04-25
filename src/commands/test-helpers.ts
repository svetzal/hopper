import { mock } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ParsedArgs } from "../cli.ts";
import type { GitGateway } from "../gateways/git-gateway.ts";
import * as storeModule from "../store.ts";

export function makeParsed(
  command: string,
  positional: string[] = [],
  flags: Record<string, string | boolean> = {},
  arrayFlags: Record<string, string[]> = {},
): ParsedArgs {
  return { command, positional, flags, arrayFlags };
}

export function makeItem(overrides?: Partial<storeModule.Item>): storeModule.Item {
  return {
    id: crypto.randomUUID(),
    title: "Test item",
    description: "A test description",
    status: "queued",
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

export function makeClaimedItem(
  overrides?: Partial<storeModule.ClaimedItem>,
): storeModule.ClaimedItem {
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
      storeModule.setStoreDir(tempDir);
    },
    afterEach: async () => {
      await rm(tempDir, { recursive: true });
    },
  };
}

export function makeMockGit(overrides?: Partial<GitGateway>): GitGateway {
  return {
    branchExists: mock(async () => true),
    remoteBranchExists: mock(async () => false),
    createTrackingBranch: mock(async () => {}),
    createBranch: mock(async () => {}),
    createWorktree: mock(async () => {}),
    worktreeRemove: mock(async () => {}),
    isWorktreeDirty: mock(async () => false),
    commitAll: mock(async () => {}),
    getCurrentBranch: mock(async () => "main"),
    checkout: mock(async () => {}),
    mergeFastForward: mock(async () => 0),
    mergeCommit: mock(async () => 0),
    mergeAbort: mock(async () => {}),
    mergeNoEdit: mock(async () => ({ exitCode: 0, stderr: "" })),
    deleteBranch: mock(async () => {}),
    push: mock(async () => ({ success: true, message: "Pushed." })),
    pushTags: mock(async () => ({ success: true, message: "Tags pushed." })),
    diffSummary: mock(async () => "src/foo.ts | 2 +-"),
    branchIsAncestorOf: mock(async () => true),
    listWorktreesForBranch: mock(async () => []),
    forceDeleteBranch: mock(async () => {}),
    ...overrides,
  };
}

export function makeMockStoreModule<T extends Record<string, unknown> = Record<never, never>>(
  extraMocks?: T,
) {
  const realRequeueItem = storeModule.requeueItem;
  const completeItem = mock(async () => ({
    completed: { title: "done" } as storeModule.Item,
    recurred: undefined as storeModule.Item | undefined,
  }));
  const recordItemPhase = mock(async () => {});
  const requeueItem = mock(async (id: string, reason: string, agent?: string) =>
    realRequeueItem(id, reason, agent),
  );
  const baseMocks = { completeItem, recordItemPhase, requeueItem };
  const mocks = { ...baseMocks, ...(extraMocks ?? {}) } as typeof baseMocks & T;
  return {
    moduleObject: { ...storeModule, ...mocks } as unknown as typeof storeModule,
    mocks,
  };
}
