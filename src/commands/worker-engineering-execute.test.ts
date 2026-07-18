import { afterAll, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import type { AgentRunner, SessionOptions } from "../gateways/agent-runner.ts";
import type { FsGateway } from "../gateways/fs-gateway.ts";
import type { Profile } from "../profile.ts";
import type { EngineeringItem, PhaseRecord } from "../store.ts";
import * as storeModule from "../store.ts";
import { callArgs, makeClaimedItem, makeMockGit, typedMock } from "../test-helpers.ts";
import type { EngineeringAuditPaths } from "../worker-workflow.ts";
import { runExecuteValidateLoop, runPhase } from "./worker-engineering.ts";

const TEST_PROFILE: Profile = {
  name: "test",
  runner: "claude",
  models: { deep: { model: "opus" }, balanced: { model: "sonnet" }, fast: { model: "haiku" } },
};

const completeItemSpy = spyOn(storeModule, "completeItem").mockImplementation(async () => ({
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
const recordItemPhaseSpy = spyOn(storeModule, "recordItemPhase").mockImplementation(async () => {});
afterAll(() => {
  completeItemSpy.mockRestore();
  recordItemPhaseSpy.mockRestore();
});
const recordItemPhaseMock = recordItemPhaseSpy;

const HOPPER_HOME = "/tmp/test-hopper-loop";
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

const noop: (msg: string) => void = () => {};

function makeEngineeringItem(overrides: Partial<storeModule.ClaimedItem> = {}): EngineeringItem {
  return makeClaimedItem({
    id: ITEM_ID,
    workingDir: "/repo",
    branch: "main",
    type: "engineering",
    ...overrides,
  }) as EngineeringItem;
}

// ---------------------------------------------------------------------------
// runPhase
// ---------------------------------------------------------------------------

describe("runPhase", () => {
  beforeEach(() => {
    recordItemPhaseMock.mockClear();
  });

  test("returns { result, exitCode } from the injected runSession", async () => {
    const claude: AgentRunner = {
      runSession: mock(async () => ({ exitCode: 0, result: "plan output" })),
      generateText: mock(async () => ({ exitCode: 0, text: "" })),
    };

    const { result, exitCode } = await runPhase({
      claude,
      profile: TEST_PROFILE,
      itemId: ITEM_ID,
      prompt: "plan prompt",
      worktreePath: "/worktree",
      auditFile: "/audit.jsonl",
      sessionOptions: {} as SessionOptions,
      phaseRecord: (_run, startedAt, endedAt) => ({
        name: "plan",
        startedAt,
        endedAt,
        exitCode: _run.exitCode,
      }),
      log: noop,
    });

    expect(result).toBe("plan output");
    expect(exitCode).toBe(0);
  });

  test("calls phaseRecord with the run result and timestamps, then records via recordItemPhase", async () => {
    const capturedRun: { exitCode: number; result: string }[] = [];
    const capturedRecord: PhaseRecord[] = [];
    const claude: AgentRunner = {
      runSession: mock(async () => ({ exitCode: 42, result: "phase text" })),
      generateText: mock(async () => ({ exitCode: 0, text: "" })),
    };

    await runPhase({
      claude,
      profile: TEST_PROFILE,
      itemId: ITEM_ID,
      prompt: "prompt",
      worktreePath: "/worktree",
      auditFile: "/audit.jsonl",
      sessionOptions: {} as SessionOptions,
      phaseRecord: (run, startedAt, endedAt) => {
        capturedRun.push(run);
        const record: PhaseRecord = { name: "plan", startedAt, endedAt, exitCode: run.exitCode };
        capturedRecord.push(record);
        return record;
      },
      log: noop,
    });

    expect(capturedRun).toHaveLength(1);
    expect(capturedRun[0]).toEqual({ exitCode: 42, result: "phase text" });
    const firstRecord = capturedRecord[0] as PhaseRecord;
    expect(firstRecord.name).toBe("plan");
    expect(firstRecord.exitCode).toBe(42);
    expect(recordItemPhaseMock).toHaveBeenCalledTimes(1);
    const [recordedId, recordedPhase] = callArgs(recordItemPhaseMock, 0);
    expect(recordedId).toBe(ITEM_ID);
    expect(recordedPhase).toEqual(firstRecord);
  });

  test("throwing recordItemPhase is swallowed by safeRecordPhase without propagating", async () => {
    const claude: AgentRunner = {
      runSession: mock(async () => ({ exitCode: 0, result: "ok" })),
      generateText: mock(async () => ({ exitCode: 0, text: "" })),
    };
    recordItemPhaseMock.mockImplementationOnce(async () => {
      throw new Error("phase recording exploded");
    });

    await expect(
      runPhase({
        claude,
        profile: TEST_PROFILE,
        itemId: ITEM_ID,
        prompt: "prompt",
        worktreePath: "/worktree",
        auditFile: "/audit.jsonl",
        sessionOptions: {} as SessionOptions,
        phaseRecord: (_run, startedAt, endedAt) => ({
          name: "plan",
          startedAt,
          endedAt,
          exitCode: _run.exitCode,
        }),
        log: noop,
      }),
    ).resolves.toEqual({ result: "ok", exitCode: 0 });
  });

  test("preserves terminalFailure on the returned run outcome", async () => {
    const claude: AgentRunner = {
      runSession: mock(async () => ({
        exitCode: 1,
        result: TERMINAL_FAILURE.message,
        terminalFailure: TERMINAL_FAILURE,
      })),
      generateText: mock(async () => ({ exitCode: 0, text: "" })),
    };

    await expect(
      runPhase({
        claude,
        profile: TEST_PROFILE,
        itemId: ITEM_ID,
        prompt: "prompt",
        worktreePath: "/worktree",
        auditFile: "/audit.jsonl",
        sessionOptions: {} as SessionOptions,
        phaseRecord: (_run, startedAt, endedAt) => ({
          name: "execute",
          startedAt,
          endedAt,
          exitCode: _run.exitCode,
        }),
        log: noop,
      }),
    ).resolves.toEqual({
      exitCode: 1,
      result: TERMINAL_FAILURE.message,
      terminalFailure: TERMINAL_FAILURE,
    });
  });
});

// ---------------------------------------------------------------------------
// runExecuteValidateLoop
// ---------------------------------------------------------------------------

describe("runExecuteValidateLoop", () => {
  test("returns { passed: true } when validate emits PASS on first attempt", async () => {
    const item = makeEngineeringItem();
    const claude: AgentRunner = {
      runSession: mock(async (prompt: string) => {
        if (prompt.includes("EXECUTE phase")) return { exitCode: 0, result: "done" };
        return { exitCode: 0, result: "All good.\n\nVALIDATE: PASS" };
      }),
      generateText: mock(async () => ({ exitCode: 0, text: "" })),
    };
    const fs = makeMockFs();

    const result = await runExecuteValidateLoop({
      item,
      worktreePath: "/worktree",
      planText: "plan text",
      paths: makePaths(),
      hopperHome: HOPPER_HOME,
      deps: { claude, fs, git: makeMockGit(), profile: TEST_PROFILE },
      log: noop,
    });

    expect(result.passed).toBe(true);
    expect(result.executeResults).toHaveLength(1);
    expect(result.validateResults).toHaveLength(1);
  });

  test("returns { passed: false } when execute exits non-zero", async () => {
    const item = makeEngineeringItem();
    const claude: AgentRunner = {
      runSession: mock(async (prompt: string) => {
        if (prompt.includes("EXECUTE phase")) return { exitCode: 1, result: "error" };
        return { exitCode: 0, result: "VALIDATE: PASS" };
      }),
      generateText: mock(async () => ({ exitCode: 0, text: "" })),
    };
    const fs = makeMockFs();

    const result = await runExecuteValidateLoop({
      item,
      worktreePath: "/worktree",
      planText: "plan text",
      paths: makePaths(),
      hopperHome: HOPPER_HOME,
      deps: { claude, fs, git: makeMockGit(), profile: TEST_PROFILE },
      log: noop,
    });

    expect(result.passed).toBe(false);
    // Validate should not have run
    expect(result.validateResults).toHaveLength(0);
  });

  test("returns { passed: false } after exhausting retries", async () => {
    const item = makeEngineeringItem({ retries: 1 });
    const claude: AgentRunner = {
      runSession: mock(async (prompt: string) => {
        if (prompt.includes("EXECUTE phase")) return { exitCode: 0, result: "done" };
        return { exitCode: 0, result: "broken\n\nVALIDATE: FAIL" };
      }),
      generateText: mock(async () => ({ exitCode: 0, text: "" })),
    };
    const fs = makeMockFs();

    const result = await runExecuteValidateLoop({
      item,
      worktreePath: "/worktree",
      planText: "plan text",
      paths: makePaths(),
      hopperHome: HOPPER_HOME,
      deps: { claude, fs, git: makeMockGit(), profile: TEST_PROFILE },
      log: noop,
    });

    expect(result.passed).toBe(false);
    // 2 attempts (1 + 1 retry): 2 execute and 2 validate results
    expect(result.executeResults).toHaveLength(2);
    expect(result.validateResults).toHaveLength(2);
  });

  test("uses remediation prompt for attempt > 1", async () => {
    const item = makeEngineeringItem({ retries: 1 });
    let validateCalls = 0;
    const sessionCalls: string[] = [];
    const claude: AgentRunner = {
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

    await runExecuteValidateLoop({
      item,
      worktreePath: "/worktree",
      planText: "plan text",
      paths: makePaths(),
      hopperHome: HOPPER_HOME,
      deps: { claude, fs, git: makeMockGit(), profile: TEST_PROFILE },
      log: noop,
    });

    const remediationCall = sessionCalls.find(
      (p) => p.includes("EXECUTE phase") && p.includes("remediation"),
    );
    expect(remediationCall).toBeDefined();
  });

  test("accumulates execute and validate results in transcript arrays", async () => {
    const item = makeEngineeringItem({ retries: 1 });
    let validateCalls = 0;
    const claude: AgentRunner = {
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

    const result = await runExecuteValidateLoop({
      item,
      worktreePath: "/worktree",
      planText: "plan text",
      paths: makePaths(),
      hopperHome: HOPPER_HOME,
      deps: { claude, fs, git: makeMockGit(), profile: TEST_PROFILE },
      log: noop,
    });

    expect(result.passed).toBe(true);
    expect(result.executeResults).toHaveLength(2);
    expect(result.validateResults).toHaveLength(2);
    expect(result.validateResults[0]).toContain("val-result-1");
    expect(result.validateResults[1]).toContain("val-result-2");
  });

  test("writes failure result file when execute fails", async () => {
    const item = makeEngineeringItem();
    const paths = makePaths();
    const claude: AgentRunner = {
      runSession: mock(async () => ({ exitCode: 1, result: "broken" })),
      generateText: mock(async () => ({ exitCode: 0, text: "" })),
    };
    const fs = makeMockFs();

    await runExecuteValidateLoop({
      item,
      worktreePath: "/worktree",
      planText: "plan",
      paths,
      hopperHome: HOPPER_HOME,
      deps: { claude, fs, git: makeMockGit(), profile: TEST_PROFILE },
      log: noop,
    });

    const execFailWriteMock = typedMock(fs.writeFile);
    const resultWrite = execFailWriteMock.mock.calls.find((c) => c[0] === paths.resultFile);
    expect(resultWrite).toBeDefined();
    expect(resultWrite?.[1]).toContain("Execute phase attempt 1 failed");
  });

  test("returns terminal failure immediately and does not validate or retry", async () => {
    const item = makeEngineeringItem({ retries: 2 });
    const claude: AgentRunner = {
      runSession: mock(async (prompt: string) => {
        if (prompt.includes("EXECUTE phase")) {
          return {
            exitCode: 1,
            result: TERMINAL_FAILURE.message,
            terminalFailure: TERMINAL_FAILURE,
          };
        }
        return { exitCode: 0, result: "VALIDATE: PASS" };
      }),
      generateText: mock(async () => ({ exitCode: 0, text: "" })),
    };
    const fs = makeMockFs();

    const result = await runExecuteValidateLoop({
      item,
      worktreePath: "/worktree",
      planText: "plan",
      paths: makePaths(),
      hopperHome: HOPPER_HOME,
      deps: { claude, fs, git: makeMockGit(), profile: TEST_PROFILE },
      log: noop,
    });

    expect(result.passed).toBe(false);
    expect(result.terminalFailure).toEqual(TERMINAL_FAILURE);
    expect(result.finalResult).toContain("Terminal runner failure");
    expect(claude.runSession).toHaveBeenCalledTimes(1);
    expect(typedMock(fs.writeFile).mock.calls[0]?.[1]).toContain("Terminal runner failure");
  });

  test("validate without PASS/FAIL marker → generateText fallback assessor called, outcome reflects fallback", async () => {
    const item = makeEngineeringItem();
    const claude: AgentRunner = {
      runSession: mock(async (prompt: string) => {
        if (prompt.includes("EXECUTE phase")) return { exitCode: 0, result: "done" };
        // Validate output has no PASS/FAIL marker — triggers fallback
        return { exitCode: 0, result: "The implementation appears correct." };
      }),
      generateText: mock(async () => ({ exitCode: 0, text: "PASS" })),
    };
    const fs = makeMockFs();

    const result = await runExecuteValidateLoop({
      item,
      worktreePath: "/worktree",
      planText: "plan text",
      paths: makePaths(),
      hopperHome: HOPPER_HOME,
      deps: { claude, fs, git: makeMockGit(), profile: TEST_PROFILE },
      log: noop,
    });

    expect(claude.generateText).toHaveBeenCalledTimes(1);
    expect(result.passed).toBe(true);
  });

  test("maxRetries=0: only one execute+validate attempt even when validate FAILs", async () => {
    const item = makeEngineeringItem({ retries: 0 });
    const claude: AgentRunner = {
      runSession: mock(async (prompt: string) => {
        if (prompt.includes("EXECUTE phase")) return { exitCode: 0, result: "done" };
        return { exitCode: 0, result: "VALIDATE: FAIL" };
      }),
      generateText: mock(async () => ({ exitCode: 0, text: "" })),
    };
    const fs = makeMockFs();

    const result = await runExecuteValidateLoop({
      item,
      worktreePath: "/worktree",
      planText: "plan text",
      paths: makePaths(),
      hopperHome: HOPPER_HOME,
      deps: { claude, fs, git: makeMockGit(), profile: TEST_PROFILE },
      log: noop,
    });

    expect(result.passed).toBe(false);
    expect(result.executeResults).toHaveLength(1);
    expect(result.validateResults).toHaveLength(1);
  });

  test("execute fails every attempt until exhaustion: all attempt results accumulated", async () => {
    const item = makeEngineeringItem({ retries: 2 });
    let executeCalls = 0;
    const claude: AgentRunner = {
      runSession: mock(async (prompt: string) => {
        if (prompt.includes("EXECUTE phase")) {
          executeCalls++;
          return { exitCode: 1, result: `execute-failure-${executeCalls}` };
        }
        return { exitCode: 0, result: "VALIDATE: PASS" };
      }),
      generateText: mock(async () => ({ exitCode: 0, text: "" })),
    };
    const fs = makeMockFs();

    const result = await runExecuteValidateLoop({
      item,
      worktreePath: "/worktree",
      planText: "plan text",
      paths: makePaths(),
      hopperHome: HOPPER_HOME,
      deps: { claude, fs, git: makeMockGit(), profile: TEST_PROFILE },
      log: noop,
    });

    // Non-zero execute exit stops the loop immediately after first failure
    expect(result.passed).toBe(false);
    expect(result.executeResults).toHaveLength(1);
    expect(result.validateResults).toHaveLength(0);
    expect(result.executeResults[0]).toContain("execute-failure-1");
  });
});
