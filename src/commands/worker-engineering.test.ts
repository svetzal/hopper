import { afterAll, afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import type { AgentRunner } from "../gateways/agent-runner.ts";
import type { FsGateway } from "../gateways/fs-gateway.ts";
import type { GitGateway } from "../gateways/git-gateway.ts";
import type { Profile } from "../profile.ts";
import type { EngineeringItem } from "../store.ts";
import * as store from "../store.ts";

const TEST_PROFILE: Profile = {
  name: "test",
  runner: "claude",
  models: { deep: { model: "opus" }, balanced: { model: "sonnet" }, fast: { model: "haiku" } },
};

import {
  callArgs,
  makeClaimedItem,
  makeItem,
  makeMockGit,
  setupTempStoreDir,
  typedMock,
} from "../test-helpers.ts";

function makeEngineeringItem(overrides?: Partial<store.ClaimedItem>): EngineeringItem {
  return makeClaimedItem({
    workingDir: "/repo",
    branch: "main",
    ...overrides,
  }) as EngineeringItem;
}

import type { EngineeringAuditPaths } from "../worker-workflow.ts";
import {
  commitEngineeringChanges,
  type EngineeringContext,
  processEngineeringItem,
  resolveChangedCheckoutPaths,
  resolveWorkBranch,
  runEngineeringPreconditions,
  runPlanPhase,
  setupEngineeringWorktree,
} from "./worker-engineering.ts";

const realRequeueItem = store.requeueItem;
const completeItemSpy = spyOn(store, "completeItem").mockImplementation(async () => ({
  ok: true as const,
  value: {
    completed: {
      id: "x",
      title: "done",
      status: "completed" as const,
      description: "",
      createdAt: "",
    },
    recurred: undefined,
  },
}));
const recordItemPhaseSpy = spyOn(store, "recordItemPhase").mockImplementation(async () => {});
const requeueItemSpy = spyOn(store, "requeueItem").mockImplementation(async (id, reason, agent) =>
  realRequeueItem(id, reason, agent),
);
const mockSetItemEngineeringBranchSlug = spyOn(
  store,
  "setItemEngineeringBranchSlug",
).mockImplementation(async () => {});
afterAll(() => {
  completeItemSpy.mockRestore();
  recordItemPhaseSpy.mockRestore();
  requeueItemSpy.mockRestore();
  mockSetItemEngineeringBranchSlug.mockRestore();
});
const requeueItemMock = requeueItemSpy;

const HOPPER_HOME = "/tmp/test-hopper-eng";
const ITEM_ID = "aaaaaaaa-0000-0000-0000-000000000000";
const TERMINAL_FAILURE = {
  provider: "anthropic",
  failureKind: "account_limit",
  terminal: true,
  apiErrorStatus: 429,
  message: "You've hit your monthly spend limit - raise it at claude.ai/settings/usage",
} as const;

function makePaths(): EngineeringAuditPaths {
  return {
    auditDir: `${HOPPER_HOME}/audit`,
    planAuditFile: `${HOPPER_HOME}/audit/${ITEM_ID}-plan.jsonl`,
    executeAuditFile: `${HOPPER_HOME}/audit/${ITEM_ID}-execute.jsonl`,
    validateAuditFile: `${HOPPER_HOME}/audit/${ITEM_ID}-validate.jsonl`,
    planFile: `${HOPPER_HOME}/audit/${ITEM_ID}-plan.md`,
    resultFile: `${HOPPER_HOME}/audit/${ITEM_ID}-result.md`,
  };
}

function makeMockFs(): FsGateway {
  return {
    ensureDir: mock(async () => {}),
    writeFile: mock(async () => {}),
  };
}

function makeMockClaude(): AgentRunner {
  return {
    runSession: mock(async () => ({ exitCode: 0, result: "" })),
    generateText: mock(async () => ({ exitCode: 0, text: "" })),
  };
}

const noop: (msg: string) => void = () => {};

describe("resolveChangedCheckoutPaths", () => {
  test("returns paths whose porcelain entries changed", () => {
    expect(
      resolveChangedCheckoutPaths(
        " M already-dirty.ts\n",
        " M already-dirty.ts\n M src/wrong.ts\n",
      ),
    ).toEqual(["src/wrong.ts"]);
  });

  test("returns no paths when the original checkout status is unchanged", () => {
    expect(resolveChangedCheckoutPaths(" M existing.ts\n", " M existing.ts\n")).toEqual([]);
  });
});

function makeEngineeringCtx(overrides?: {
  item?: EngineeringItem;
  claude?: AgentRunner;
  fs?: FsGateway;
  git?: GitGateway;
  worktreePath?: string;
  paths?: EngineeringAuditPaths;
  log?: (msg: string) => void;
}): EngineeringContext {
  const {
    item = makeEngineeringItem({ id: ITEM_ID }),
    claude = makeMockClaude(),
    fs = makeMockFs(),
    git = makeMockGit(),
    worktreePath = "/worktree",
    paths = makePaths(),
    log = noop,
  } = overrides ?? {};
  return {
    item,
    agentName: "test-agent",
    worktreePath,
    hopperHome: HOPPER_HOME,
    paths,
    deps: { git, claude, fs, profile: TEST_PROFILE },
    log,
  };
}

// ---------------------------------------------------------------------------
// runPlanPhase
// ---------------------------------------------------------------------------

describe("runPlanPhase", () => {
  test("returns { planText } on success", async () => {
    const item = makeEngineeringItem({ id: ITEM_ID });
    const claude: AgentRunner = {
      runSession: mock(async () => ({
        exitCode: 0,
        result: "  ## Approach\nDo the thing.  ",
      })),
      generateText: mock(async () => ({ exitCode: 0, text: "" })),
    };

    const result = await runPlanPhase(makeEngineeringCtx({ item, claude }));

    if ("terminalFailure" in result || "planFailed" in result) {
      throw new Error("Expected successful plan result");
    }
    expect(result.planText).toBe("## Approach\nDo the thing.");
  });

  test("returns planFailed with finalResult when plan exit code is non-zero", async () => {
    const item = makeEngineeringItem({ id: ITEM_ID });
    const claude: AgentRunner = {
      runSession: mock(async () => ({ exitCode: 1, result: "Plan crashed." })),
      generateText: mock(async () => ({ exitCode: 0, text: "" })),
    };

    const result = await runPlanPhase(makeEngineeringCtx({ item, claude }));

    if (!("planFailed" in result)) {
      throw new Error("Expected planFailed result");
    }
    expect(result.planFailed).toBe(true);
    expect(result.finalResult).toContain("Plan crashed.");
    expect(result.finalResult).toContain("Plan phase failed (exit 1)");
  });

  test("returns planFailed when plan text is empty after trimming", async () => {
    const item = makeEngineeringItem({ id: ITEM_ID });
    const claude: AgentRunner = {
      runSession: mock(async () => ({ exitCode: 0, result: "   " })),
      generateText: mock(async () => ({ exitCode: 0, text: "" })),
    };

    const result = await runPlanPhase(makeEngineeringCtx({ item, claude }));

    if (!("planFailed" in result)) {
      throw new Error("Expected planFailed result");
    }
    expect(result.planFailed).toBe(true);
  });

  test("writes plan file on success", async () => {
    const item = makeEngineeringItem({ id: ITEM_ID });
    const paths = makePaths();
    const claude: AgentRunner = {
      runSession: mock(async () => ({ exitCode: 0, result: "plan content" })),
      generateText: mock(async () => ({ exitCode: 0, text: "" })),
    };
    const fs = makeMockFs();

    await runPlanPhase(makeEngineeringCtx({ item, claude, fs, paths }));

    const writeFileMock = typedMock(fs.writeFile);
    const planWrite = writeFileMock.mock.calls.find((c) => c[0] === paths.planFile);
    expect(planWrite).toBeDefined();
    expect(planWrite?.[1]).toBe("plan content");
  });

  test("writes failure result file on non-zero exit", async () => {
    const item = makeEngineeringItem({ id: ITEM_ID });
    const paths = makePaths();
    const claude: AgentRunner = {
      runSession: mock(async () => ({ exitCode: 2, result: "crashed" })),
      generateText: mock(async () => ({ exitCode: 0, text: "" })),
    };
    const fs = makeMockFs();

    await runPlanPhase(makeEngineeringCtx({ item, claude, fs, paths }));

    const planFailWriteMock = typedMock(fs.writeFile);
    const resultWrite = planFailWriteMock.mock.calls.find((c) => c[0] === paths.resultFile);
    expect(resultWrite).toBeDefined();
    expect(resultWrite?.[1]).toContain("Plan phase failed");
  });

  test("returns terminal failure metadata and writes the terminal summary", async () => {
    const item = makeEngineeringItem({ id: ITEM_ID });
    const paths = makePaths();
    const claude: AgentRunner = {
      runSession: mock(async () => ({
        exitCode: 1,
        result: TERMINAL_FAILURE.message,
        terminalFailure: TERMINAL_FAILURE,
      })),
      generateText: mock(async () => ({ exitCode: 0, text: "" })),
    };
    const fs = makeMockFs();

    const result = await runPlanPhase(makeEngineeringCtx({ item, claude, fs, paths }));

    expect(result).toEqual({
      terminalFailure: TERMINAL_FAILURE,
      finalResult:
        "Terminal runner failure: anthropic account_limit (HTTP 429 monthly spend limit)\n\nProvider message: You've hit your monthly spend limit - raise it at claude.ai/settings/usage",
    });
    expect(typedMock(fs.writeFile).mock.calls[0]?.[1]).toContain("Terminal runner failure");
  });
});

// ---------------------------------------------------------------------------
// commitEngineeringChanges
// ---------------------------------------------------------------------------

describe("commitEngineeringChanges", () => {
  test("returns { dirty: true } and commits when worktree is dirty", async () => {
    const item = makeEngineeringItem({ id: ITEM_ID });
    const git = makeMockGit({
      isWorktreeDirty: mock(async () => true),
    });
    const claude: AgentRunner = {
      runSession: mock(async () => ({ exitCode: 0, result: "" })),
      generateText: mock(async () => ({ exitCode: 0, text: "feat: my commit" })),
    };

    const result = await commitEngineeringChanges(makeEngineeringCtx({ item, git, claude }));

    expect(result.dirty).toBe(true);
    expect(git.commitAll).toHaveBeenCalledTimes(1);
  });

  test("returns { dirty: false } and skips commit when worktree is clean", async () => {
    const item = makeEngineeringItem({ id: ITEM_ID });
    const git = makeMockGit({
      isWorktreeDirty: mock(async () => false),
    });
    const claude: AgentRunner = {
      runSession: mock(async () => ({ exitCode: 0, result: "" })),
      generateText: mock(async () => ({ exitCode: 0, text: "" })),
    };

    const result = await commitEngineeringChanges(makeEngineeringCtx({ item, git, claude }));

    expect(result.dirty).toBe(false);
    expect(git.commitAll).not.toHaveBeenCalled();
    expect(git.stageAll).not.toHaveBeenCalled();
    expect(git.diffSummary).not.toHaveBeenCalled();
  });

  test("stages BEFORE summarising the diff (so untracked files appear in the commit message)", async () => {
    // Regression: a from-scratch project leaves every file untracked. `git
    // diff HEAD` excludes untracked, so the commit-message model would see an
    // empty diff. stageAll must run before diffSummary.
    const item = makeEngineeringItem({ id: ITEM_ID });
    const callOrder: string[] = [];
    const git = makeMockGit({
      isWorktreeDirty: mock(async () => true),
      stageAll: mock(async () => {
        callOrder.push("stageAll");
      }),
      diffSummary: mock(async () => {
        callOrder.push("diffSummary");
        return "src/foo.rs | 10 +";
      }),
      commitAll: mock(async () => {
        callOrder.push("commitAll");
      }),
    });
    const claude: AgentRunner = {
      runSession: mock(async () => ({ exitCode: 0, result: "" })),
      generateText: mock(async () => ({ exitCode: 0, text: "feat: implement foo" })),
    };

    await commitEngineeringChanges(makeEngineeringCtx({ item, git, claude }));

    expect(callOrder).toEqual(["stageAll", "diffSummary", "commitAll"]);
  });
});

// ---------------------------------------------------------------------------
// runEngineeringPreconditions
// ---------------------------------------------------------------------------

describe("runEngineeringPreconditions", () => {
  const storeDir = setupTempStoreDir("hopper-precond-test-");
  beforeEach(async () => {
    await storeDir.beforeEach();
    requeueItemMock.mockClear();
  });
  afterEach(storeDir.afterEach);

  test("returns { ok: false } and requeues when workingDir is missing", async () => {
    const item = makeClaimedItem({ id: ITEM_ID, workingDir: undefined, branch: "main" });
    await store.saveItems([item]);
    const fs = makeMockFs();

    const result = await runEngineeringPreconditions({
      item,
      agentName: "test-agent",
      hopperHome: HOPPER_HOME,
      deps: { fs },
      log: noop,
    });

    expect(result.ok).toBe(false);
    expect(requeueItemMock).toHaveBeenCalledTimes(1);
    const [calledId, reason] = callArgs(requeueItemMock, 0);
    expect(calledId).toBe(ITEM_ID);
    expect(reason).toContain("--dir");
  });

  test("returns { ok: true, item } when both fields present", async () => {
    const item = makeClaimedItem({ id: ITEM_ID, workingDir: "/repo", branch: "main" });
    const fs = makeMockFs();

    const result = await runEngineeringPreconditions({
      item,
      agentName: "test-agent",
      hopperHome: HOPPER_HOME,
      deps: { fs },
      log: noop,
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.item.workingDir).toBe("/repo");
      expect(result.item.branch).toBe("main");
    }
    expect(requeueItemMock).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// resolveWorkBranch
// ---------------------------------------------------------------------------

describe("resolveWorkBranch", () => {
  beforeEach(() => {
    mockSetItemEngineeringBranchSlug.mockClear();
  });

  test("cached slug → generateText NOT called, returns deterministic branch name", async () => {
    const item = makeEngineeringItem({ id: ITEM_ID, engineeringBranchSlug: "my-slug" });
    const claude: AgentRunner = {
      runSession: mock(async () => ({ exitCode: 0, result: "" })),
      generateText: mock(async () => ({ exitCode: 0, text: "" })),
    };

    const workBranch = await resolveWorkBranch(makeEngineeringCtx({ item, claude }));

    expect(claude.generateText).not.toHaveBeenCalled();
    expect(mockSetItemEngineeringBranchSlug).not.toHaveBeenCalled();
    expect(workBranch).toContain("my-slug");
  });

  test("no cached slug → generateText called and slug persisted", async () => {
    const item = makeEngineeringItem({ id: ITEM_ID });
    const claude: AgentRunner = {
      runSession: mock(async () => ({ exitCode: 0, result: "" })),
      generateText: mock(async () => ({ exitCode: 0, text: "generated-slug" })),
    };

    const workBranch = await resolveWorkBranch(makeEngineeringCtx({ item, claude }));

    expect(claude.generateText).toHaveBeenCalledTimes(1);
    expect(mockSetItemEngineeringBranchSlug).toHaveBeenCalledTimes(1);
    const [persistedId, persistedSlug] = callArgs(mockSetItemEngineeringBranchSlug, 0);
    expect(persistedId).toBe(ITEM_ID);
    expect(persistedSlug).toBe("generated-slug");
    expect(workBranch).toContain("generated-slug");
  });
});

// ---------------------------------------------------------------------------
// setupEngineeringWorktree
// ---------------------------------------------------------------------------

describe("setupEngineeringWorktree", () => {
  const storeDir = setupTempStoreDir("hopper-worktree-test-");
  beforeEach(async () => {
    await storeDir.beforeEach();
    requeueItemMock.mockClear();
  });
  afterEach(storeDir.afterEach);

  const defaultWorktreePath = `/tmp/test-hopper-eng/worktrees/${ITEM_ID}`;
  const defaultSetup = {
    workingDir: "/repo",
    branch: "main",
    workBranch: "hopper-eng/test-slug-aaaaaaaa",
  };

  test("success → returns { ok: true } and calls orchestrateWorktreeSetup", async () => {
    const item = makeEngineeringItem({ id: ITEM_ID });
    const git = makeMockGit();
    const fs = makeMockFs();

    const result = await setupEngineeringWorktree(
      makeEngineeringCtx({ item, git, fs, worktreePath: defaultWorktreePath }),
      defaultSetup,
    );

    expect(result.ok).toBe(true);
    expect(git.createWorktree).toHaveBeenCalled();
  });

  test("StaleEngineeringBranchError → returns { ok: false } with 'Stale branch:' requeue reason", async () => {
    const item = makeEngineeringItem({ id: ITEM_ID });
    await store.saveItems([item]);
    const git = makeMockGit({
      branchExists: mock(async () => true),
      listWorktreesForBranch: mock(async () => []),
      branchIsAncestorOf: mock(async () => false),
    });
    const fs = makeMockFs();

    const result = await setupEngineeringWorktree(
      makeEngineeringCtx({ item, git, fs, worktreePath: defaultWorktreePath }),
      defaultSetup,
    );

    expect(result.ok).toBe(false);
    expect(requeueItemMock).toHaveBeenCalledTimes(1);
    const [, reason] = callArgs(requeueItemMock, 0);
    expect(reason).toContain("Stale branch");
  });

  test("generic error → returns { ok: false } with 'Worktree setup failed:' requeue reason", async () => {
    const item = makeEngineeringItem({ id: ITEM_ID });
    await store.saveItems([item]);
    const git = makeMockGit({
      createWorktree: mock(async () => {
        throw new Error("disk full");
      }),
    });
    const fs = makeMockFs();

    const result = await setupEngineeringWorktree(
      makeEngineeringCtx({ item, git, fs, worktreePath: defaultWorktreePath }),
      defaultSetup,
    );

    expect(result.ok).toBe(false);
    expect(requeueItemMock).toHaveBeenCalledTimes(1);
    const [, reason] = callArgs(requeueItemMock, 0);
    expect(reason).toContain("Worktree setup failed");
  });
});

// ---------------------------------------------------------------------------
// processEngineeringItem
// ---------------------------------------------------------------------------

describe("processEngineeringItem", () => {
  const AGENT_NAME = "test-agent";

  // Isolate the store so the pass-through requeueItem can find and transition
  // items without touching the user's real ~/.hopper/items.json.
  const storeDir = setupTempStoreDir("hopper-eng-test-");

  beforeEach(async () => {
    await storeDir.beforeEach();
    requeueItemMock.mockClear();
    mockSetItemEngineeringBranchSlug.mockClear();
  });

  afterEach(storeDir.afterEach);

  function makeFullDeps(gitOverrides?: Partial<GitGateway>): {
    git: GitGateway;
    claude: AgentRunner;
    fs: FsGateway;
    profile: Profile;
  } {
    return {
      git: makeMockGit(gitOverrides),
      claude: {
        runSession: mock(async () => ({ exitCode: 0, result: "VALIDATE: PASS" })),
        generateText: mock(async () => ({ exitCode: 0, text: "my-slug" })),
      },
      fs: makeMockFs(),
      profile: TEST_PROFILE,
    };
  }

  test("createWorktree failure → requeueItem called with setup reason, claude.runSession never called", async () => {
    const item = makeClaimedItem({ id: ITEM_ID, workingDir: "/repo", branch: "main" });
    // Seed the temp store with the claimed item so the pass-through requeueItem can find it
    await store.saveItems([item]);
    const deps = makeFullDeps({
      createWorktree: mock(async () => {
        throw new Error("git worktree add failed: branch already exists");
      }),
    });

    await processEngineeringItem({ item, agentName: AGENT_NAME, hopperHome: HOPPER_HOME, deps });

    expect(requeueItemMock).toHaveBeenCalledTimes(1);
    const [calledId, reason] = callArgs(requeueItemMock, 0);
    expect(calledId).toBe(ITEM_ID);
    expect(reason).toContain("Worktree setup failed");
    // Verify the real store was actually updated
    const reloadedResult = await store.findItem(ITEM_ID);
    const reloaded = reloadedResult.ok ? reloadedResult.value : null;
    expect(reloaded?.status).toBe("queued");
    expect(reloaded?.requeueReason).toContain("Worktree setup failed");
    expect(deps.claude.runSession).not.toHaveBeenCalled();
  });

  test("phase prompts do not expose the original checkout path", async () => {
    const item = makeClaimedItem({
      id: ITEM_ID,
      description: "Edit /repo/src/app.ts in /repo.",
      workingDir: "/repo",
      branch: "main",
      type: "engineering",
      retries: 0,
    });
    await store.saveItems([item]);
    const deps = makeFullDeps();

    await processEngineeringItem({ item, agentName: AGENT_NAME, hopperHome: HOPPER_HOME, deps });

    for (const call of typedMock(deps.claude.runSession).mock.calls) {
      expect(call[0]).not.toContain("/repo");
    }
  });

  test("fails before validate when execute changes the original checkout", async () => {
    const item = makeClaimedItem({
      id: ITEM_ID,
      workingDir: "/repo",
      branch: "main",
      type: "engineering",
      retries: 0,
    });
    await store.saveItems([item]);
    let statusCall = 0;
    const deps = makeFullDeps({
      statusPorcelain: mock(async () =>
        statusCall++ === 0 ? " M pre-existing.ts\n" : " M pre-existing.ts\n M src/wrong.ts\n",
      ),
    });

    await processEngineeringItem({ item, agentName: AGENT_NAME, hopperHome: HOPPER_HOME, deps });

    expect(deps.claude.runSession).toHaveBeenCalledTimes(2); // plan + execute; validate never runs
    expect(deps.git.worktreeRemove).not.toHaveBeenCalled();
    const resultWrites = typedMock(deps.fs.writeFile).mock.calls.filter(
      ([path]) => path === `${HOPPER_HOME}/audit/${ITEM_ID}-result.md`,
    );
    expect(resultWrites.at(-1)?.[1]).toContain("modified the original checkout");
    expect(resultWrites.at(-1)?.[1]).toContain("src/wrong.ts");
    expect(resultWrites.at(-1)?.[1]).toContain("Changes were left untouched");
  });

  test("StaleEngineeringBranchError → requeueItem called with stale branch reason", async () => {
    const item = makeClaimedItem({ id: ITEM_ID, workingDir: "/repo", branch: "main" });
    // Seed the temp store with the claimed item so the pass-through requeueItem can find it
    await store.saveItems([item]);
    // branchExists=true, no worktrees, ancestor=false → orchestrateWorktreeSetup throws StaleEngineeringBranchError
    const deps = makeFullDeps({
      branchExists: mock(async () => true),
      listWorktreesForBranch: mock(async () => []),
      branchIsAncestorOf: mock(async () => false),
    });

    await processEngineeringItem({ item, agentName: AGENT_NAME, hopperHome: HOPPER_HOME, deps });

    expect(requeueItemMock).toHaveBeenCalledTimes(1);
    const [, staleReason] = callArgs(requeueItemMock, 0);
    expect(staleReason).toContain("Stale branch");
    // Verify the real store was actually updated
    const reloadedResult = await store.findItem(ITEM_ID);
    const reloaded = reloadedResult.ok ? reloadedResult.value : null;
    expect(reloaded?.status).toBe("queued");
    expect(reloaded?.requeueReason).toContain("Stale branch");
    expect(deps.claude.runSession).not.toHaveBeenCalled();
  });

  test("item with cached engineeringBranchSlug → generateText NOT called; cached slug used in createWorktree arg", async () => {
    const item = makeClaimedItem({
      id: ITEM_ID,
      workingDir: "/repo",
      branch: "main",
      engineeringBranchSlug: "cached-slug",
    });
    const deps = makeFullDeps();

    await processEngineeringItem({ item, agentName: AGENT_NAME, hopperHome: HOPPER_HOME, deps });

    expect(deps.claude.generateText).not.toHaveBeenCalled();
    // Slug should NOT be re-persisted when already cached
    expect(mockSetItemEngineeringBranchSlug).not.toHaveBeenCalled();
    // The work branch passed to createWorktree should contain the cached slug
    const [, , cachedBranchArg] = callArgs(typedMock(deps.git.createWorktree), 0);
    expect(cachedBranchArg).toContain("cached-slug");
  });

  test("item without slug → generateText called once and setItemEngineeringBranchSlug called with persisted value", async () => {
    const item = makeClaimedItem({ id: ITEM_ID, workingDir: "/repo", branch: "main" });
    // generateText returns a fresh slug
    const deps = makeFullDeps();
    typedMock(deps.claude.generateText).mockImplementation(async () => ({
      exitCode: 0,
      text: "fresh-slug",
    }));

    await processEngineeringItem({ item, agentName: AGENT_NAME, hopperHome: HOPPER_HOME, deps });

    expect(deps.claude.generateText).toHaveBeenCalledTimes(1);
    expect(mockSetItemEngineeringBranchSlug).toHaveBeenCalledTimes(1);
    const [persistedId, persistedSlug] = callArgs(mockSetItemEngineeringBranchSlug, 0);
    expect(persistedId).toBe(ITEM_ID);
    expect(persistedSlug).toBe("fresh-slug");
    // Work branch should include the persisted slug
    const [, , freshBranchArg] = callArgs(typedMock(deps.git.createWorktree), 0);
    expect(freshBranchArg).toContain("fresh-slug");
  });

  test("post-spawn failure (runSession throws) → error propagates, no requeue", async () => {
    const item = makeClaimedItem({ id: ITEM_ID, workingDir: "/repo", branch: "main" });
    await store.saveItems([item]);
    const deps = makeFullDeps();
    // Worktree setup succeeds; plan-phase runSession throws unexpectedly
    typedMock(deps.claude.runSession).mockImplementation(async () => {
      throw new Error("unexpected crash in plan phase");
    });

    await expect(
      processEngineeringItem({ item, agentName: AGENT_NAME, hopperHome: HOPPER_HOME, deps }),
    ).rejects.toThrow("unexpected crash in plan phase");
    // Pre-spawn succeeded, so no requeue should have been attempted
    expect(requeueItemMock).not.toHaveBeenCalled();
  });

  test("pre-spawn failure + safeRequeue failure (double-fault) → no rethrow", async () => {
    const item = makeClaimedItem({ id: ITEM_ID, workingDir: "/repo", branch: "main" });
    await store.saveItems([item]);
    const deps = makeFullDeps({
      createWorktree: mock(async () => {
        throw new Error("worktree failed");
      }),
    });
    // Also make the requeue call fail
    requeueItemMock.mockImplementationOnce(
      async (_id: string, _reason: string, _agent?: string) => {
        throw new Error("requeue also failed");
      },
    );

    // Neither worktree setup nor requeue succeeded, but the function must not rethrow
    await expect(
      processEngineeringItem({ item, agentName: AGENT_NAME, hopperHome: HOPPER_HOME, deps }),
    ).resolves.toBeUndefined();
    // safeRequeue was still attempted despite the failure
    expect(requeueItemMock).toHaveBeenCalledTimes(1);
  });

  test("preserved worktree at expected path + clean + no commits ahead → no requeue, proceeds to plan phase", async () => {
    const item = makeClaimedItem({
      id: ITEM_ID,
      workingDir: "/repo",
      branch: "main",
      engineeringBranchSlug: "my-slug",
    });
    // Seed the temp store with the claimed item so the pass-through requeueItem can find it
    await store.saveItems([item]);

    // workBranch = buildEngineeringBranchName(ITEM_ID, "my-slug") = "hopper-eng/my-slug-aaaaaaaa"
    const workBranch = "hopper-eng/my-slug-aaaaaaaa";
    const expectedWorktreePath = `${HOPPER_HOME}/worktrees/${ITEM_ID}`;

    const deps = makeFullDeps({
      branchExists: mock(async () => true),
      // Worktree for workBranch is at exactly the expected path
      listWorktreesForBranch: mock(async (_, b) =>
        b === workBranch ? [expectedWorktreePath] : [],
      ),
      isWorktreeDirty: mock(async () => false),
      // workBranch is ancestor of target → no commits ahead
      branchIsAncestorOf: mock(async () => true),
    });

    await processEngineeringItem({ item, agentName: AGENT_NAME, hopperHome: HOPPER_HOME, deps });

    // The preserved worktree should be reused — no new worktree created
    expect(deps.git.createWorktree).not.toHaveBeenCalled();
    // No requeue should have occurred
    expect(requeueItemMock).not.toHaveBeenCalled();
    // Plan phase (and subsequent phases) should have run
    expect(deps.claude.runSession).toHaveBeenCalled();
  });

  // ---------------------------------------------------------------------------
  // Step 6 — Branch slug and commit message generation failure fallbacks
  // ---------------------------------------------------------------------------

  test("generateText throws during slug generation → falls back to ID-only branch name, no exception", async () => {
    const item = makeClaimedItem({ id: ITEM_ID, workingDir: "/repo", branch: "main" });
    const deps = makeFullDeps();
    typedMock(deps.claude.generateText).mockImplementation(async () => {
      throw new Error("LLM unavailable");
    });

    await expect(
      processEngineeringItem({ item, agentName: AGENT_NAME, hopperHome: HOPPER_HOME, deps }),
    ).resolves.toBeUndefined();

    // Fallback branch name is hopper-eng/<8-char-id-prefix>
    const [, , branchArg] = callArgs(typedMock(deps.git.createWorktree), 0);
    expect(branchArg).toBe(`hopper-eng/${ITEM_ID.slice(0, 8)}`);
    // generateText was attempted but threw
    expect(deps.claude.generateText).toHaveBeenCalledTimes(1);
  });

  test("generateText throws during commit message generation → falls back to item title", async () => {
    const item = makeEngineeringItem({ id: ITEM_ID });
    const git = makeMockGit({
      isWorktreeDirty: mock(async () => true),
    });
    const claude: AgentRunner = {
      runSession: mock(async () => ({ exitCode: 0, result: "" })),
      generateText: mock(async () => {
        throw new Error("LLM timed out");
      }),
    };
    const logs: string[] = [];

    const result = await commitEngineeringChanges(
      makeEngineeringCtx({ item, git, claude, log: (msg) => logs.push(msg) }),
    );

    expect(result.dirty).toBe(true);
    // commitAll called with item title as fallback commit message
    const [, commitMsg] = callArgs(typedMock(git.commitAll), 0);
    expect(commitMsg).toBe(item.title);
    expect(logs.some((l) => l.includes("Commit message generation failed"))).toBe(true);
  });

  // ---------------------------------------------------------------------------
  // Step 7 — Missing workingDir/branch early-exit
  // ---------------------------------------------------------------------------

  test("missing workingDir → early requeue, no phase pipeline entered", async () => {
    const item = makeClaimedItem({ id: ITEM_ID, workingDir: undefined, branch: "main" });
    await store.saveItems([item]);
    const deps = makeFullDeps();

    await processEngineeringItem({ item, agentName: AGENT_NAME, hopperHome: HOPPER_HOME, deps });

    expect(requeueItemMock).toHaveBeenCalledTimes(1);
    const [calledId, reason] = callArgs(requeueItemMock, 0);
    expect(calledId).toBe(ITEM_ID);
    expect(reason).toContain("--dir");
    expect(deps.claude.runSession).not.toHaveBeenCalled();
    expect(deps.git.createWorktree).not.toHaveBeenCalled();
  });

  // ---------------------------------------------------------------------------
  // Step 8 — fs.ensureDir failure triggers auto-requeue
  // ---------------------------------------------------------------------------

  // ---------------------------------------------------------------------------
  // Terminal `failed` status — regression for the zombie-in_progress bug where
  // an exhausted validate budget left the item in_progress forever, and the
  // per-workingDir claim serialization then blocked every later queued item
  // for the same repo (observed 2026-07-16, item b77a91b1 / parite-cli).
  // ---------------------------------------------------------------------------

  test("validate retry budget exhausted → item transitions to failed; worktree preserved; same-dir queue unblocked", async () => {
    const item = makeClaimedItem({
      id: ITEM_ID,
      workingDir: "/repo/project",
      branch: "main",
      engineeringBranchSlug: "my-slug",
      retries: 1,
    });
    await store.saveItems([item]);
    completeItemSpy.mockClear();
    const deps = makeFullDeps();
    let sessions = 0;
    typedMock(deps.claude.runSession).mockImplementation(async () => {
      sessions += 1;
      if (sessions === 1) return { exitCode: 0, result: "the plan" };
      // After plan: even calls are execute, odd calls are validate.
      return sessions % 2 === 0
        ? { exitCode: 0, result: "did the work" }
        : { exitCode: 0, result: "VALIDATE: FAIL" };
    });

    await processEngineeringItem({ item, agentName: AGENT_NAME, hopperHome: HOPPER_HOME, deps });

    // plan + 2 × (execute + validate) — the full retry budget was spent
    expect(sessions).toBe(5);

    const reloadedResult = await store.findItem(ITEM_ID);
    const reloaded = reloadedResult.ok ? reloadedResult.value : null;
    expect(reloaded?.status).toBe("failed");
    expect(reloaded?.failedAt).toBeDefined();
    expect(reloaded?.failedBy).toBe(AGENT_NAME);
    expect(reloaded?.claimToken).toBeUndefined();
    expect(reloaded?.result).toContain("Validate did not pass after 2/2 attempt(s)");

    // Worktree + work branch preserved exactly as the run left them
    expect(deps.git.worktreeRemove).not.toHaveBeenCalled();
    expect(deps.git.deleteBranch).not.toHaveBeenCalled();
    // Neither completed nor requeued — failed is its own terminal state
    expect(completeItemSpy).not.toHaveBeenCalled();
    expect(requeueItemMock).not.toHaveBeenCalled();

    // THE regression: a later queued item for the same workingDir is claimable
    // (the failed item no longer counts as busy for directory serialization).
    const queued = makeItem({ title: "Next in line", workingDir: "/repo/project" });
    await store.saveItems([...(await store.loadItems()), queued]);
    const claimed = await store.claimNextItem("agent-2");
    expect(claimed?.id).toBe(queued.id);
  });

  test("plan phase failure → item transitions to failed, not left in_progress", async () => {
    const item = makeClaimedItem({
      id: ITEM_ID,
      workingDir: "/repo/project",
      branch: "main",
      engineeringBranchSlug: "my-slug",
    });
    await store.saveItems([item]);
    const deps = makeFullDeps();
    typedMock(deps.claude.runSession).mockImplementation(async () => ({
      exitCode: 1,
      result: "plan crashed",
    }));

    await processEngineeringItem({ item, agentName: AGENT_NAME, hopperHome: HOPPER_HOME, deps });

    const reloadedResult = await store.findItem(ITEM_ID);
    const reloaded = reloadedResult.ok ? reloadedResult.value : null;
    expect(reloaded?.status).toBe("failed");
    expect(reloaded?.result).toContain("Plan phase failed (exit 1)");
    expect(deps.git.worktreeRemove).not.toHaveBeenCalled();
    expect(requeueItemMock).not.toHaveBeenCalled();
  });

  test("execute phase non-zero exit → item transitions to failed", async () => {
    const item = makeClaimedItem({
      id: ITEM_ID,
      workingDir: "/repo/project",
      branch: "main",
      engineeringBranchSlug: "my-slug",
    });
    await store.saveItems([item]);
    const deps = makeFullDeps();
    let sessions = 0;
    typedMock(deps.claude.runSession).mockImplementation(async () => {
      sessions += 1;
      if (sessions === 1) return { exitCode: 0, result: "the plan" };
      return { exitCode: 2, result: "execute blew up" };
    });

    await processEngineeringItem({ item, agentName: AGENT_NAME, hopperHome: HOPPER_HOME, deps });

    const reloadedResult = await store.findItem(ITEM_ID);
    const reloaded = reloadedResult.ok ? reloadedResult.value : null;
    expect(reloaded?.status).toBe("failed");
    expect(reloaded?.result).toContain("Execute phase attempt 1 failed (exit 2)");
    expect(deps.git.worktreeRemove).not.toHaveBeenCalled();
  });

  test("fs.ensureDir failure during audit dir creation → auto-requeue, no worktree setup", async () => {
    const item = makeClaimedItem({ id: ITEM_ID, workingDir: "/repo", branch: "main" });
    await store.saveItems([item]);
    const deps = makeFullDeps();
    typedMock(deps.fs.ensureDir).mockImplementationOnce(async () => {
      throw new Error("ENOSPC: no space left on device");
    });

    await processEngineeringItem({ item, agentName: AGENT_NAME, hopperHome: HOPPER_HOME, deps });

    expect(requeueItemMock).toHaveBeenCalledTimes(1);
    const [calledId, reason] = callArgs(requeueItemMock, 0);
    expect(calledId).toBe(ITEM_ID);
    expect(reason).toContain("Worktree setup failed");
    expect(deps.git.createWorktree).not.toHaveBeenCalled();
  });
});
