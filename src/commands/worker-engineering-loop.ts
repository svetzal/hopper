import { buildEngineeringFailureResult } from "../engineering-workflow.ts";
import type { AgentRunner, SessionOptions } from "../gateways/agent-runner.ts";
import type { Profile } from "../profile.ts";
import type { ClaimedItem, PhaseRecord } from "../store.ts";
import { recordItemPhase } from "../store.ts";
import {
  buildExecuteOptions,
  buildExecutePrompt,
  buildExecuteRemediationPrompt,
  buildValidateOptions,
  buildValidatePrompt,
} from "../task-type-workflow.ts";
import { type EngineeringAuditPaths, resolveAttemptAuditPath } from "../worker-workflow.ts";
import { resolveValidateOutcomeWithFallback } from "./worker-engineering-text.ts";
import { type LogFn, safeVoid, type WorkerRunnerDeps } from "./worker-shared.ts";

async function safeRecordPhase(itemId: string, record: PhaseRecord, log: LogFn): Promise<void> {
  return safeVoid(() => recordItemPhase(itemId, record), "Phase recording failed", log);
}

export async function runPhase(
  claude: AgentRunner,
  profile: Profile,
  args: {
    itemId: string;
    prompt: string;
    worktreePath: string;
    auditFile: string;
    sessionOptions: SessionOptions;
    phaseRecord: (
      run: { exitCode: number; result: string },
      startedAt: string,
      endedAt: string,
    ) => PhaseRecord | Promise<PhaseRecord>;
    log: LogFn;
  },
): Promise<{ result: string; exitCode: number }> {
  const { itemId, prompt, worktreePath, auditFile, sessionOptions, phaseRecord, log } = args;
  const startedAt = new Date().toISOString();
  const run = await claude.runSession(prompt, worktreePath, auditFile, {
    ...sessionOptions,
    profile,
  });
  const endedAt = new Date().toISOString();
  const record = await phaseRecord(run, startedAt, endedAt);
  await safeRecordPhase(itemId, record, log);
  return { result: run.result, exitCode: run.exitCode };
}

interface ExecuteValidateResult {
  passed: boolean;
  reason: string;
  executeResults: readonly string[];
  validateResults: readonly string[];
}

export interface ExecuteValidateContext {
  item: ClaimedItem;
  worktreePath: string;
  planText: string;
  paths: EngineeringAuditPaths;
  hopperHome: string;
  deps: Pick<WorkerRunnerDeps, "claude" | "fs" | "profile">;
  log: LogFn;
}

async function runExecuteAttempt(
  ctx: ExecuteValidateContext,
  attempt: number,
  maxAttempts: number,
  previousExecuteResult: string,
  previousValidateResult: string,
): Promise<{ result: string; exitCode: number }> {
  const { item, worktreePath, planText, hopperHome, deps, log } = ctx;
  const { claude, profile } = deps;
  const executeAuditPath = resolveAttemptAuditPath(item.id, hopperHome, "execute", attempt);
  const isRemediation = attempt > 1;
  log(
    `Execute phase attempt ${attempt}/${maxAttempts} (balanced${
      item.agent ? `, agent: ${item.agent}` : ""
    }${isRemediation ? ", remediation" : ""})...\nAudit log: ${executeAuditPath}`,
  );
  const executePrompt = isRemediation
    ? buildExecuteRemediationPrompt(
        item,
        planText,
        previousExecuteResult,
        previousValidateResult,
        attempt,
      )
    : buildExecutePrompt(item, planText);
  return runPhase(claude, profile, {
    itemId: item.id,
    prompt: executePrompt,
    worktreePath,
    auditFile: executeAuditPath,
    sessionOptions: buildExecuteOptions(item.agent),
    phaseRecord: (run, startedAt, endedAt) => ({
      name: "execute",
      startedAt,
      endedAt,
      exitCode: run.exitCode,
      attempt,
    }),
    log,
  });
}

async function runValidateAttempt(
  ctx: ExecuteValidateContext,
  attempt: number,
  maxAttempts: number,
): Promise<{
  outcome: { passed: boolean; reason: string; fallbackUsed?: boolean };
  result: string;
}> {
  const { item, worktreePath, planText, hopperHome, deps, log } = ctx;
  const { claude, profile } = deps;
  const validateAuditPath = resolveAttemptAuditPath(item.id, hopperHome, "validate", attempt);
  log(
    `Validate phase attempt ${attempt}/${maxAttempts} (deep, read-only git)...\nAudit log: ${validateAuditPath}`,
  );
  let outcome: { passed: boolean; reason: string; fallbackUsed?: boolean } = {
    passed: false,
    reason: "not resolved",
  };
  const { result } = await runPhase(claude, profile, {
    itemId: item.id,
    prompt: buildValidatePrompt(item, planText),
    worktreePath,
    auditFile: validateAuditPath,
    sessionOptions: buildValidateOptions(),
    phaseRecord: async (run, startedAt, endedAt) => {
      outcome = await resolveValidateOutcomeWithFallback(
        run.exitCode,
        run.result,
        claude,
        profile,
        log,
      );
      return {
        name: "validate",
        startedAt,
        endedAt,
        exitCode: run.exitCode,
        passed: outcome.passed,
        attempt,
        ...(outcome.fallbackUsed ? { fallbackUsed: true } : {}),
      };
    },
    log,
  });
  return { outcome, result };
}

export async function runExecuteValidateLoop(
  ctx: ExecuteValidateContext,
): Promise<ExecuteValidateResult> {
  const { item, planText, paths, deps, log } = ctx;
  const { fs } = deps;
  // One execute → validate attempt, then up to `maxRetries` remediation
  // attempts when validate reports FAIL. Each attempt writes its own
  // per-attempt audit file and records phase entries so `hopper show`
  // reflects progress in real time.
  const maxRetries = item.retries ?? 1;
  const maxAttempts = 1 + maxRetries;
  let attempt = 0;
  let outcome: { passed: boolean; reason: string; fallbackUsed?: boolean } = {
    passed: false,
    reason: "not run",
  };
  const executeResults: string[] = [];
  const validateResults: string[] = [];
  let previousExecuteResult = "";
  let previousValidateResult = "";

  async function writeEngineeringFailure(msg: string): Promise<void> {
    log(msg);
    await fs.writeFile(
      paths.resultFile,
      buildEngineeringFailureResult(planText, executeResults, validateResults, msg),
    );
  }

  while (attempt < maxAttempts) {
    attempt += 1;

    const executeAttempt = await runExecuteAttempt(
      ctx,
      attempt,
      maxAttempts,
      previousExecuteResult,
      previousValidateResult,
    );
    executeResults.push(executeAttempt.result);
    previousExecuteResult = executeAttempt.result;

    if (executeAttempt.exitCode !== 0) {
      const msg = `Execute phase attempt ${attempt} failed (exit ${executeAttempt.exitCode}); worktree + branch preserved.`;
      await writeEngineeringFailure(msg);
      return { passed: false, reason: msg, executeResults, validateResults };
    }

    const validateAttempt = await runValidateAttempt(ctx, attempt, maxAttempts);
    validateResults.push(validateAttempt.result);
    previousValidateResult = validateAttempt.result;
    outcome = validateAttempt.outcome;

    if (outcome.passed) break;

    if (attempt < maxAttempts) {
      log(
        `Validate attempt ${attempt} did not pass (${outcome.reason}); remediating (attempt ${attempt + 1}/${maxAttempts})...`,
      );
    }
  }

  if (!outcome.passed) {
    const msg = `Validate did not pass after ${attempt}/${maxAttempts} attempt(s) (${outcome.reason}); worktree + branch preserved.`;
    await writeEngineeringFailure(msg);
    return { passed: false, reason: outcome.reason, executeResults, validateResults };
  }

  return { passed: true, reason: outcome.reason, executeResults, validateResults };
}
