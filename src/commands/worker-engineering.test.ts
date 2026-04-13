import { describe, expect, mock, test } from "bun:test";
import type { ClaudeGateway } from "../gateways/claude-gateway.ts";
import type { FsGateway } from "../gateways/fs-gateway.ts";
import type { GitGateway } from "../gateways/git-gateway.ts";
// Mock the store module so tests don't touch real ~/.hopper/items.json
import * as store from "../store.ts";
import type { EngineeringAuditPaths } from "../worker-workflow.ts";
import { makeClaimedItem } from "./test-helpers.ts";
import { commitEngineeringChanges, runExecuteValidateLoop, runPlanPhase } from "./worker.ts";

mock.module("../store.ts", () => ({
  ...store,
  completeItem: mock(async () => ({
    completed: { title: "done" },
    recurred: undefined,
  })),
  recordItemPhase: mock(async () => {}),
}));

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

function makeMockGit(overrides?: Partial<GitGateway>): GitGateway {
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
    deleteBranch: mock(async () => {}),
    push: mock(async () => ({ success: true, message: "Pushed." })),
    pushTags: mock(async () => ({ success: true, message: "Tags pushed." })),
    diffSummary: mock(async () => "src/foo.ts | 2 +-"),
    ...overrides,
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
