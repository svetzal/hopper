import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import type { ClaudeGateway } from "../gateways/claude-gateway.ts";
import type { FsGateway } from "../gateways/fs-gateway.ts";
import type { GitGateway } from "../gateways/git-gateway.ts";
import * as store from "../store.ts";
import {
  makeClaimedItem,
  makeMockGit,
  makeMockStoreModule,
  setupTempStoreDir,
} from "../test-helpers.ts";
import type { EngineeringAuditPaths } from "../worker-workflow.ts";
import {
  commitEngineeringChanges,
  processEngineeringItem,
  runExecuteValidateLoop,
  runPlanPhase,
} from "./worker-engineering.ts";

const mockSetItemEngineeringBranchSlug = mock(async () => {});
const storeMocks = makeMockStoreModule({
  setItemEngineeringBranchSlug: mockSetItemEngineeringBranchSlug,
});
mock.module("../store.ts", () => storeMocks.moduleObject);
const requeueItemMock = storeMocks.mocks.requeueItem as ReturnType<typeof mock>;

const HOPPER_HOME = "/tmp/test-hopper-eng";
const ITEM_ID = "aaaaaaaa-0000-0000-0000-000000000000";

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

const noop: (msg: string) => void = () => {};

// ---------------------------------------------------------------------------
// runPlanPhase
// ---------------------------------------------------------------------------

describe("runPlanPhase", () => {
  test("returns { planText } on success", async () => {
    const item = makeClaimedItem({ id: ITEM_ID, workingDir: "/repo", branch: "main" });
    const claude: ClaudeGateway = {
      runSession: mock(async () => ({
        exitCode: 0,
        result: "  ## Approach\nDo the thing.  ",
      })),
      generateText: mock(async () => ({ exitCode: 0, text: "" })),
    };
    const fs = makeMockFs();

    const result = await runPlanPhase(item, "/worktree", makePaths(), { claude, fs }, noop);

    expect(result).not.toBeNull();
    expect(result?.planText).toBe("## Approach\nDo the thing.");
  });

  test("returns null when plan exit code is non-zero", async () => {
    const item = makeClaimedItem({ id: ITEM_ID });
    const claude: ClaudeGateway = {
      runSession: mock(async () => ({ exitCode: 1, result: "Plan crashed." })),
      generateText: mock(async () => ({ exitCode: 0, text: "" })),
    };
    const fs = makeMockFs();

    const result = await runPlanPhase(item, "/worktree", makePaths(), { claude, fs }, noop);

    expect(result).toBeNull();
  });

  test("returns null when plan text is empty after trimming", async () => {
    const item = makeClaimedItem({ id: ITEM_ID });
    const claude: ClaudeGateway = {
      runSession: mock(async () => ({ exitCode: 0, result: "   " })),
      generateText: mock(async () => ({ exitCode: 0, text: "" })),
    };
    const fs = makeMockFs();

    const result = await runPlanPhase(item, "/worktree", makePaths(), { claude, fs }, noop);

    expect(result).toBeNull();
  });

  test("writes plan file on success", async () => {
    const item = makeClaimedItem({ id: ITEM_ID });
    const paths = makePaths();
    const claude: ClaudeGateway = {
      runSession: mock(async () => ({ exitCode: 0, result: "plan content" })),
      generateText: mock(async () => ({ exitCode: 0, text: "" })),
    };
    const fs = makeMockFs();

    await runPlanPhase(item, "/worktree", paths, { claude, fs }, noop);

    const writeCalls = (fs.writeFile as ReturnType<typeof mock>).mock.calls as unknown[][];
    const planWrite = writeCalls.find((c) => (c[0] as string) === paths.planFile);
    expect(planWrite).toBeDefined();
    expect(planWrite?.[1]).toBe("plan content");
  });

  test("writes failure result file on non-zero exit", async () => {
    const item = makeClaimedItem({ id: ITEM_ID });
    const paths = makePaths();
    const claude: ClaudeGateway = {
      runSession: mock(async () => ({ exitCode: 2, result: "crashed" })),
      generateText: mock(async () => ({ exitCode: 0, text: "" })),
    };
    const fs = makeMockFs();

    await runPlanPhase(item, "/worktree", paths, { claude, fs }, noop);

    const writeCalls = (fs.writeFile as ReturnType<typeof mock>).mock.calls as unknown[][];
    const resultWrite = writeCalls.find((c) => (c[0] as string) === paths.resultFile);
    expect(resultWrite).toBeDefined();
    expect(resultWrite?.[1] as string).toContain("Plan phase failed");
  });
});

// ---------------------------------------------------------------------------
// runExecuteValidateLoop
// ---------------------------------------------------------------------------

describe("runExecuteValidateLoop", () => {
  test("returns { passed: true } when validate emits PASS on first attempt", async () => {
    const item = makeClaimedItem({ id: ITEM_ID });
    const claude: ClaudeGateway = {
      runSession: mock(async (prompt: string) => {
        if (prompt.includes("EXECUTE phase")) return { exitCode: 0, result: "done" };
        return { exitCode: 0, result: "All good.\n\nVALIDATE: PASS" };
      }),
      generateText: mock(async () => ({ exitCode: 0, text: "" })),
    };
    const fs = makeMockFs();

    const result = await runExecuteValidateLoop(
      item,
      "/worktree",
      "plan text",
      makePaths(),
      HOPPER_HOME,
      { claude, fs },
      noop,
    );

    expect(result.passed).toBe(true);
    expect(result.executeResults).toHaveLength(1);
    expect(result.validateResults).toHaveLength(1);
  });

  test("returns { passed: false } when execute exits non-zero", async () => {
    const item = makeClaimedItem({ id: ITEM_ID });
    const claude: ClaudeGateway = {
      runSession: mock(async (prompt: string) => {
        if (prompt.includes("EXECUTE phase")) return { exitCode: 1, result: "error" };
        return { exitCode: 0, result: "VALIDATE: PASS" };
      }),
      generateText: mock(async () => ({ exitCode: 0, text: "" })),
    };
    const fs = makeMockFs();

    const result = await runExecuteValidateLoop(
      item,
      "/worktree",
      "plan text",
      makePaths(),
      HOPPER_HOME,
      { claude, fs },
      noop,
    );

    expect(result.passed).toBe(false);
    // Validate should not have run
    expect(result.validateResults).toHaveLength(0);
  });

  test("returns { passed: false } after exhausting retries", async () => {
    const item = makeClaimedItem({ id: ITEM_ID, retries: 1 });
    const claude: ClaudeGateway = {
      runSession: mock(async (prompt: string) => {
        if (prompt.includes("EXECUTE phase")) return { exitCode: 0, result: "done" };
        return { exitCode: 0, result: "broken\n\nVALIDATE: FAIL" };
      }),
      generateText: mock(async () => ({ exitCode: 0, text: "" })),
    };
    const fs = makeMockFs();

    const result = await runExecuteValidateLoop(
      item,
      "/worktree",
      "plan text",
      makePaths(),
      HOPPER_HOME,
      { claude, fs },
      noop,
    );

    expect(result.passed).toBe(false);
    // 2 attempts (1 + 1 retry): 2 execute and 2 validate results
    expect(result.executeResults).toHaveLength(2);
    expect(result.validateResults).toHaveLength(2);
  });

  test("uses remediation prompt for attempt > 1", async () => {
    const item = makeClaimedItem({ id: ITEM_ID, retries: 1 });
    let validateCalls = 0;
    const sessionCalls: string[] = [];
    const claude: ClaudeGateway = {
      runSession: mock(async (prompt: string) => {
        sessionCalls.push(prompt);
        if (prompt.includes("EXECUTE phase")) return { exitCode: 0, result: "executed" };
        validateCalls += 1;
        return validateCalls === 1
          ? { exitCode: 0, result: "VALIDATE: FAIL" }
          : { exitCode: 0, result: "VALIDATE: PASS" };
      }),
      generateText: mock(async () => ({ exitCode: 0, text: "" })),
    };
    const fs = makeMockFs();

    await runExecuteValidateLoop(
      item,
      "/worktree",
      "plan text",
      makePaths(),
      HOPPER_HOME,
      { claude, fs },
      noop,
    );

    const remediationCall = sessionCalls.find(
      (p) => p.includes("EXECUTE phase") && p.includes("remediation"),
    );
    expect(remediationCall).toBeDefined();
  });

  test("accumulates execute and validate results in transcript arrays", async () => {
    const item = makeClaimedItem({ id: ITEM_ID, retries: 1 });
    let validateCalls = 0;
    const claude: ClaudeGateway = {
      runSession: mock(async (prompt: string) => {
        if (prompt.includes("EXECUTE phase")) return { exitCode: 0, result: `exec-result` };
        validateCalls += 1;
        return validateCalls === 1
          ? { exitCode: 0, result: "val-result-1\nVALIDATE: FAIL" }
          : { exitCode: 0, result: "val-result-2\nVALIDATE: PASS" };
      }),
      generateText: mock(async () => ({ exitCode: 0, text: "" })),
    };
    const fs = makeMockFs();

    const result = await runExecuteValidateLoop(
      item,
      "/worktree",
      "plan text",
      makePaths(),
      HOPPER_HOME,
      { claude, fs },
      noop,
    );

    expect(result.passed).toBe(true);
    expect(result.executeResults).toHaveLength(2);
    expect(result.validateResults).toHaveLength(2);
    expect(result.validateResults[0]).toContain("val-result-1");
    expect(result.validateResults[1]).toContain("val-result-2");
  });

  test("writes failure result file when execute fails", async () => {
    const item = makeClaimedItem({ id: ITEM_ID });
    const paths = makePaths();
    const claude: ClaudeGateway = {
      runSession: mock(async () => ({ exitCode: 1, result: "broken" })),
      generateText: mock(async () => ({ exitCode: 0, text: "" })),
    };
    const fs = makeMockFs();

    await runExecuteValidateLoop(
      item,
      "/worktree",
      "plan",
      paths,
      HOPPER_HOME,
      { claude, fs },
      noop,
    );

    const writeCalls = (fs.writeFile as ReturnType<typeof mock>).mock.calls as unknown[][];
    const resultWrite = writeCalls.find((c) => (c[0] as string) === paths.resultFile);
    expect(resultWrite).toBeDefined();
    expect(resultWrite?.[1] as string).toContain("Execute phase attempt 1 failed");
  });
});

// ---------------------------------------------------------------------------
// commitEngineeringChanges
// ---------------------------------------------------------------------------

describe("commitEngineeringChanges", () => {
  test("returns { dirty: true } and commits when worktree is dirty", async () => {
    const item = makeClaimedItem({ id: ITEM_ID });
    const git = makeMockGit({
      isWorktreeDirty: mock(async () => true),
    });
    const claude: ClaudeGateway = {
      runSession: mock(async () => ({ exitCode: 0, result: "" })),
      generateText: mock(async () => ({ exitCode: 0, text: "feat: my commit" })),
    };

    const result = await commitEngineeringChanges(item, "/worktree", { git, claude }, noop);

    expect(result.dirty).toBe(true);
    expect(git.commitAll).toHaveBeenCalledTimes(1);
  });

  test("returns { dirty: false } and skips commit when worktree is clean", async () => {
    const item = makeClaimedItem({ id: ITEM_ID });
    const git = makeMockGit({
      isWorktreeDirty: mock(async () => false),
    });
    const claude: ClaudeGateway = {
      runSession: mock(async () => ({ exitCode: 0, result: "" })),
      generateText: mock(async () => ({ exitCode: 0, text: "" })),
    };

    const result = await commitEngineeringChanges(item, "/worktree", { git, claude }, noop);

    expect(result.dirty).toBe(false);
    expect(git.commitAll).not.toHaveBeenCalled();
    expect(git.diffSummary).not.toHaveBeenCalled();
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
    claude: ClaudeGateway;
    fs: FsGateway;
  } {
    return {
      git: makeMockGit(gitOverrides),
      claude: {
        runSession: mock(async () => ({ exitCode: 0, result: "VALIDATE: PASS" })),
        generateText: mock(async () => ({ exitCode: 0, text: "my-slug" })),
      },
      fs: makeMockFs(),
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

    await processEngineeringItem(item, AGENT_NAME, HOPPER_HOME, deps);

    expect(requeueItemMock).toHaveBeenCalledTimes(1);
    const [calledId, reason] = requeueItemMock.mock.calls[0] as [string, string, string];
    expect(calledId).toBe(ITEM_ID);
    expect(reason).toContain("Worktree setup failed");
    // Verify the real store was actually updated
    const reloaded = await store.findItem(ITEM_ID);
    expect(reloaded.status).toBe("queued");
    expect(reloaded.requeueReason).toContain("Worktree setup failed");
    expect(deps.claude.runSession).not.toHaveBeenCalled();
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

    await processEngineeringItem(item, AGENT_NAME, HOPPER_HOME, deps);

    expect(requeueItemMock).toHaveBeenCalledTimes(1);
    const [, reason] = requeueItemMock.mock.calls[0] as [string, string, string];
    expect(reason).toContain("Stale branch");
    // Verify the real store was actually updated
    const reloaded = await store.findItem(ITEM_ID);
    expect(reloaded.status).toBe("queued");
    expect(reloaded.requeueReason).toContain("Stale branch");
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

    await processEngineeringItem(item, AGENT_NAME, HOPPER_HOME, deps);

    expect(deps.claude.generateText).not.toHaveBeenCalled();
    // Slug should NOT be re-persisted when already cached
    expect(mockSetItemEngineeringBranchSlug).not.toHaveBeenCalled();
    // The work branch passed to createWorktree should contain the cached slug
    const createWorktreeCalls = (deps.git.createWorktree as ReturnType<typeof mock>).mock
      .calls as string[][];
    expect(createWorktreeCalls[0]?.[2]).toContain("cached-slug");
  });

  test("item without slug → generateText called once and setItemEngineeringBranchSlug called with persisted value", async () => {
    const item = makeClaimedItem({ id: ITEM_ID, workingDir: "/repo", branch: "main" });
    // generateText returns a fresh slug
    const deps = makeFullDeps();
    (deps.claude.generateText as ReturnType<typeof mock>).mockImplementation(async () => ({
      exitCode: 0,
      text: "fresh-slug",
    }));

    await processEngineeringItem(item, AGENT_NAME, HOPPER_HOME, deps);

    expect(deps.claude.generateText).toHaveBeenCalledTimes(1);
    expect(mockSetItemEngineeringBranchSlug).toHaveBeenCalledTimes(1);
    const [persistedId, persistedSlug] = mockSetItemEngineeringBranchSlug.mock
      .calls[0] as unknown as [string, string];
    expect(persistedId).toBe(ITEM_ID);
    expect(persistedSlug).toBe("fresh-slug");
    // Work branch should include the persisted slug
    const createWorktreeCalls = (deps.git.createWorktree as ReturnType<typeof mock>).mock
      .calls as string[][];
    expect(createWorktreeCalls[0]?.[2]).toContain("fresh-slug");
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

    await processEngineeringItem(item, AGENT_NAME, HOPPER_HOME, deps);

    // The preserved worktree should be reused — no new worktree created
    expect(deps.git.createWorktree).not.toHaveBeenCalled();
    // No requeue should have occurred
    expect(requeueItemMock).not.toHaveBeenCalled();
    // Plan phase (and subsequent phases) should have run
    expect(deps.claude.runSession).toHaveBeenCalled();
  });
});
