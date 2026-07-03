import { type Mock, mock } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ParsedArgs } from "./cli.ts";
import type { GitGateway } from "./gateways/git-gateway.ts";
import { ok } from "./result.ts";
import * as storeModule from "./store.ts";

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
    stageAll: mock(async () => {}),
    commitAll: mock(async () => {}),
    getCurrentBranch: mock(async () => "main"),
    // Default returns a fresh SHA per call so a merge appears to advance HEAD
    // (old !== new, and their short prefixes differ too). Tests that need a
    // no-op override this with a constant.
    revParse: mock(
      ((): (() => Promise<string>) => {
        let n = 0;
        return async () => `${n++}`.padEnd(40, "0");
      })(),
    ),
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

/**
 * Cast a function value to its typed Mock equivalent.
 * Use this when extracting mocks from a mock module to get proper Mock<T> typing.
 */
// biome-ignore lint/suspicious/noExplicitAny: generic helper requires any to capture function shape
export function typedMock<T extends (...args: any[]) => any>(m: T): Mock<T> {
  return m as unknown as Mock<T>;
}

/**
 * Extract typed call arguments from a mock function at the given call index.
 * Returns a properly typed tuple matching the mock's parameter types.
 */
// biome-ignore lint/suspicious/noExplicitAny: generic helper requires any to capture function shape
export function callArgs<T extends (...args: any[]) => any>(
  m: Mock<T>,
  callIndex: number,
): Parameters<T> {
  return m.mock.calls[callIndex] as Parameters<T>;
}

type BaseMocks = {
  completeItem: Mock<typeof storeModule.completeItem>;
  recordItemPhase: Mock<typeof storeModule.recordItemPhase>;
  requeueItem: Mock<typeof storeModule.requeueItem>;
};

export function makeMockStoreModule<T extends Record<string, unknown> = Record<never, never>>(
  extraMocks?: T,
): {
  moduleObject: typeof storeModule;
  mocks: BaseMocks & T;
} {
  const realRequeueItem = storeModule.requeueItem;
  const completeItem: Mock<typeof storeModule.completeItem> = mock(async () =>
    ok({
      completed: makeItem({ title: "done", status: "completed" }),
      recurred: undefined as storeModule.Item | undefined,
    }),
  );
  const recordItemPhase: Mock<typeof storeModule.recordItemPhase> = mock(async () => {});
  const requeueItem: Mock<typeof storeModule.requeueItem> = mock(
    async (id: string, reason: string, agent?: string) => realRequeueItem(id, reason, agent),
  );
  const baseMocks: BaseMocks = { completeItem, recordItemPhase, requeueItem };
  const mocks = { ...baseMocks, ...(extraMocks ?? {}) } as BaseMocks & T;
  return {
    moduleObject: { ...storeModule, ...mocks } as unknown as typeof storeModule,
    mocks,
  };
}

/**
 * Claims the next queued item, throwing if no item is available.
 * Use in tests instead of calling `claimNextItem` directly when you need a
 * `ClaimedItem` without optional chaining or `as string` casts.
 */
export async function claimOrFail(agent?: string): Promise<storeModule.ClaimedItem> {
  const claimed = await storeModule.claimNextItem(agent);
  if (!claimed) throw new Error("Expected claimNextItem to return an item");
  return claimed;
}
