import { join } from "node:path";
import {
  buildEngineeringFailureResult,
  buildEngineeringTranscript,
  resolveEngineeringCommitFallback,
  resolveEngineeringPreconditions,
  resolveWorktreeSetupFailureReason,
} from "../engineering-workflow.ts";
import { toErrorMessage } from "../error-utils.ts";
import type { AgentRunner, RunSessionOutcome, SessionOptions } from "../gateways/agent-runner.ts";
import { buildEngineeringBranchName } from "../git-workflow.ts";
import type { Profile } from "../profile.ts";
import {
  formatTerminalRunnerFailureSummary,
  type TerminalRunnerFailure,
} from "../runner-terminal-failure.ts";
import type { ClaimedItem, EngineeringItem, PhaseRecord } from "../store.ts";
import { recordItemPhase, setItemEngineeringBranchSlug } from "../store.ts";
import {
  buildBranchSlugPrompt,
  buildCommitMessagePrompt,
  buildExecuteOptions,
  buildExecutePrompt,
  buildExecuteRemediationPrompt,
  buildGitOwnershipShimEnv,
  buildPlanOptions,
  buildPlanPrompt,
  buildValidateFallbackPrompt,
  buildValidateOptions,
  buildValidatePrompt,
  MISSING_MARKER_REASON,
  normaliseBranchSlug,
  normaliseValidateFallback,
  resolveBranchSlugSource,
  resolveValidateOutcome,
  type ValidateOutcomeWithFallback,
} from "../task-type-workflow.ts";
import {
  type EngineeringAuditPaths,
  resolveAttemptAuditPath,
  resolveAuditPaths,
  resolveEngineeringAuditPaths,
} from "../worker-workflow.ts";
import {
  createLogger,
  finalizeCompletion,
  finalizeFailure,
  finalizeWorktreeAndComplete,
  type LogFn,
  logClaimBanner,
  orchestrateWorktreeSetup,
  safeRequeue,
  safeVoid,
  type WorkerRunnerDeps,
} from "./worker-orchestration.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface EngineeringContext {
  item: EngineeringItem;
  agentName: string;
  worktreePath: string;
  hopperHome: string;
  paths: EngineeringAuditPaths;
  deps: WorkerRunnerDeps;
  log: LogFn;
}

export type ExecuteValidateContext = Pick<
  EngineeringContext,
  "worktreePath" | "paths" | "hopperHome" | "log"
> & {
  item: ClaimedItem;
  planText: string;
  deps: Pick<WorkerRunnerDeps, "claude" | "fs" | "profile">;
};

export interface SafeGenerateTextArgs {
  claude: AgentRunner;
  prompt: string;
  profile: Profile;
  label: string;
  log: LogFn;
}

export interface EngineeringBranchSlugArgs {
  claude: AgentRunner;
  profile: Profile;
  item: { title: string; description: string };
  log: LogFn;
}

export interface EngineeringCommitMessageArgs {
  claude: AgentRunner;
  profile: Profile;
  item: { title: string; description: string };
  diffSummary: string;
  log: LogFn;
}

export interface ValidateOutcomeWithFallbackArgs {
  exitCode: number;
  resultText: string;
  claude: Pick<AgentRunner, "generateText">;
  profile: Profile;
  log?: LogFn;
}

export interface EngineeringPreconditionsArgs {
  item: ClaimedItem;
  agentName: string;
  hopperHome: string;
  deps: Pick<WorkerRunnerDeps, "fs">;
  log: LogFn;
}

export interface ProcessEngineeringItemArgs {
  item: ClaimedItem;
  agentName: string;
  hopperHome: string;
  deps: WorkerRunnerDeps;
  concurrency?: number;
}

interface TerminalFailureResult {
  terminalFailure: TerminalRunnerFailure;
  finalResult: string;
}

// ---------------------------------------------------------------------------
// LLM one-shot helpers (from worker-engineering-generate)
// ---------------------------------------------------------------------------

export async function safeGenerateText(
  args: SafeGenerateTextArgs,
): Promise<{ ok: true; text: string } | { ok: false }> {
  const { claude, prompt, profile, label, log } = args;
  try {
    const { exitCode, text } = await claude.generateText(prompt, "fast", { profile });
    if (exitCode !== 0) {
      log(`${label} failed (exit ${exitCode})`);
      return { ok: false };
    }
    return { ok: true, text };
  } catch (e) {
    log(`${label} failed: ${toErrorMessage(e)}`);
    return { ok: false };
  }
}

export async function resolveEngineeringBranchSlug(
  args: EngineeringBranchSlugArgs,
): Promise<string | null> {
  const { claude, profile, item, log } = args;
  const prompt = buildBranchSlugPrompt(item.title, item.description);
  const result = await safeGenerateText({
    claude,
    prompt,
    profile,
    label: "Branch slug generation",
    log,
  });
  if (!result.ok) return null;
  return normaliseBranchSlug(result.text);
}

export async function resolveEngineeringCommitMessage(
  args: EngineeringCommitMessageArgs,
): Promise<string> {
  const { claude, profile, item, diffSummary, log } = args;
  const prompt = buildCommitMessagePrompt(item.title, item.description, diffSummary);
  const result = await safeGenerateText({
    claude,
    prompt,
    profile,
    label: "Commit message generation",
    log,
  });
  if (!result.ok) return item.title;
  return resolveEngineeringCommitFallback(
    item as Parameters<typeof resolveEngineeringCommitFallback>[0],
    result.text,
    0,
  );
}

const FALLBACK_UNCLASSIFIED_REASON = "fallback assessor could not classify (defaulting to FAIL)";

const fallbackFailOutcome = (): { passed: false; reason: string; fallbackUsed: true } => ({
  passed: false,
  reason: FALLBACK_UNCLASSIFIED_REASON,
  fallbackUsed: true,
});

export async function resolveValidateOutcomeWithFallback(
  args: ValidateOutcomeWithFallbackArgs,
): Promise<ValidateOutcomeWithFallback> {
  const { exitCode, resultText, claude, profile, log = () => {} } = args;
  const primary = resolveValidateOutcome(exitCode, resultText);

  if (primary.reason !== MISSING_MARKER_REASON) {
    return primary;
  }

  log("Validate marker missing — invoking fast fallback assessor...");

  try {
    const { exitCode: fallbackExitCode, text } = await claude.generateText(
      buildValidateFallbackPrompt(resultText),
      "fast",
      { profile },
    );

    if (fallbackExitCode !== 0) {
      log("Fallback assessor exited non-zero — defaulting to FAIL.");
      return fallbackFailOutcome();
    }

    const verdict = normaliseValidateFallback(text);

    if (verdict === "PASS") {
      log("Fallback assessor reported PASS.");
      return { passed: true, reason: "fallback assessor reported PASS", fallbackUsed: true };
    }

    if (verdict === "FAIL") {
      log("Fallback assessor reported FAIL.");
      return { passed: false, reason: "fallback assessor reported FAIL", fallbackUsed: true };
    }

    log("Fallback assessor was UNCLEAR — defaulting to FAIL.");
    return fallbackFailOutcome();
  } catch {
    log("Fallback assessor threw — defaulting to FAIL.");
    return fallbackFailOutcome();
  }
}

// ---------------------------------------------------------------------------
// Phase runner (from worker-engineering-execute)
// ---------------------------------------------------------------------------

async function safeRecordPhase(itemId: string, record: PhaseRecord, log: LogFn): Promise<void> {
  return safeVoid(() => recordItemPhase(itemId, record), "Phase recording failed", log);
}

function resolveTerminalFailureResult(failure: TerminalRunnerFailure): TerminalFailureResult {
  return {
    terminalFailure: failure,
    finalResult: formatTerminalRunnerFailureSummary(failure),
  };
}

export async function runPhase(ctx: {
  claude: AgentRunner;
  profile: Profile;
  itemId: string;
  prompt: string;
  worktreePath: string;
  auditFile: string;
  sessionOptions: SessionOptions;
  phaseRecord: (
    run: RunSessionOutcome,
    startedAt: string,
    endedAt: string,
  ) => PhaseRecord | Promise<PhaseRecord>;
  log: LogFn;
}): Promise<RunSessionOutcome> {
  const {
    claude,
    profile,
    itemId,
    prompt,
    worktreePath,
    auditFile,
    sessionOptions,
    phaseRecord,
    log,
  } = ctx;
  const startedAt = new Date().toISOString();
  const run = await claude.runSession(prompt, worktreePath, auditFile, {
    ...sessionOptions,
    profile,
  });
  const endedAt = new Date().toISOString();
  const record = await phaseRecord(run, startedAt, endedAt);
  await safeRecordPhase(itemId, record, log);
  return run;
}

// ---------------------------------------------------------------------------
// Execute → Validate retry loop (from worker-engineering-execute)
// ---------------------------------------------------------------------------

interface ExecuteValidateResult {
  passed: boolean;
  reason: string;
  executeResults: readonly string[];
  validateResults: readonly string[];
  terminalFailure?: TerminalRunnerFailure;
  /** Set on every failure path — the text already written to the result file. */
  finalResult?: string;
}

async function runExecuteAttempt(
  ctx: ExecuteValidateContext,
  attempt: number,
  maxAttempts: number,
  previousExecuteResult: string,
  previousValidateResult: string,
): Promise<RunSessionOutcome> {
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
  return runPhase({
    claude,
    profile,
    itemId: item.id,
    prompt: executePrompt,
    worktreePath,
    auditFile: executeAuditPath,
    sessionOptions: buildExecuteOptions(
      item.agent,
      buildGitOwnershipShimEnv(hopperHome, process.env.PATH ?? ""),
    ),
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
  outcome: ValidateOutcomeWithFallback;
  result: string;
  terminalFailure?: TerminalRunnerFailure;
}> {
  const { item, worktreePath, planText, hopperHome, deps, log } = ctx;
  const { claude, profile } = deps;
  const validateAuditPath = resolveAttemptAuditPath(item.id, hopperHome, "validate", attempt);
  log(
    `Validate phase attempt ${attempt}/${maxAttempts} (deep, read-only git)...\nAudit log: ${validateAuditPath}`,
  );
  let outcome: ValidateOutcomeWithFallback = {
    passed: false,
    reason: "not resolved",
  };
  const run = await runPhase({
    claude,
    profile,
    itemId: item.id,
    prompt: buildValidatePrompt(item, planText),
    worktreePath,
    auditFile: validateAuditPath,
    sessionOptions: buildValidateOptions(
      buildGitOwnershipShimEnv(hopperHome, process.env.PATH ?? ""),
    ),
    phaseRecord: async (run, startedAt, endedAt) => {
      if (run.terminalFailure?.terminal) {
        outcome = {
          passed: false,
          reason: `terminal runner failure: ${run.terminalFailure.provider} ${run.terminalFailure.failureKind}`,
        };
        return {
          name: "validate",
          startedAt,
          endedAt,
          exitCode: run.exitCode,
          passed: false,
          attempt,
        };
      }
      outcome = await resolveValidateOutcomeWithFallback({
        exitCode: run.exitCode,
        resultText: run.result,
        claude,
        profile,
        log,
      });
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
  return { outcome, result: run.result, terminalFailure: run.terminalFailure };
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
  let outcome: ValidateOutcomeWithFallback = {
    passed: false,
    reason: "not run",
  };
  const executeResults: string[] = [];
  const validateResults: string[] = [];
  let previousExecuteResult = "";
  let previousValidateResult = "";

  async function writeEngineeringFailure(msg: string): Promise<string> {
    log(msg);
    const finalResult = buildEngineeringFailureResult(
      planText,
      executeResults,
      validateResults,
      msg,
    );
    await fs.writeFile(paths.resultFile, finalResult);
    return finalResult;
  }

  async function writeTerminalFailure(
    failure: TerminalRunnerFailure,
  ): Promise<TerminalFailureResult> {
    const terminalResult = resolveTerminalFailureResult(failure);
    log(terminalResult.finalResult);
    await fs.writeFile(paths.resultFile, terminalResult.finalResult);
    return terminalResult;
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

    if (executeAttempt.terminalFailure?.terminal) {
      const terminalResult = await writeTerminalFailure(executeAttempt.terminalFailure);
      return {
        passed: false,
        reason: terminalResult.finalResult,
        executeResults,
        validateResults,
        ...terminalResult,
      };
    }

    if (executeAttempt.exitCode !== 0) {
      const msg = `Execute phase attempt ${attempt} failed (exit ${executeAttempt.exitCode}); worktree + branch preserved.`;
      const finalResult = await writeEngineeringFailure(msg);
      return { passed: false, reason: msg, executeResults, validateResults, finalResult };
    }

    const validateAttempt = await runValidateAttempt(ctx, attempt, maxAttempts);
    validateResults.push(validateAttempt.result);
    previousValidateResult = validateAttempt.result;

    if (validateAttempt.terminalFailure?.terminal) {
      const terminalResult = await writeTerminalFailure(validateAttempt.terminalFailure);
      return {
        passed: false,
        reason: terminalResult.finalResult,
        executeResults,
        validateResults,
        ...terminalResult,
      };
    }

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
    const finalResult = await writeEngineeringFailure(msg);
    return { passed: false, reason: outcome.reason, executeResults, validateResults, finalResult };
  }

  return { passed: true, reason: outcome.reason, executeResults, validateResults };
}

// ---------------------------------------------------------------------------
// Engineering pipeline (orchestration)
// ---------------------------------------------------------------------------

async function safePersistBranchSlug(itemId: string, slug: string, log: LogFn): Promise<void> {
  return safeVoid(() => setItemEngineeringBranchSlug(itemId, slug), "Slug persistence failed", log);
}

export async function runPlanPhase(
  ctx: EngineeringContext,
): Promise<
  { planText: string } | TerminalFailureResult | { planFailed: true; finalResult: string }
> {
  const { item, worktreePath, paths, deps, log } = ctx;
  const { claude, fs, profile } = deps;
  log(`Plan phase (deep, plan mode, read-only)...\nAudit log: ${paths.planAuditFile}`);
  const run = await runPhase({
    claude,
    profile,
    itemId: item.id,
    prompt: buildPlanPrompt(item),
    worktreePath,
    auditFile: paths.planAuditFile,
    sessionOptions: buildPlanOptions(),
    phaseRecord: (run, startedAt, endedAt) => ({
      name: "plan",
      startedAt,
      endedAt,
      exitCode: run.exitCode,
    }),
    log,
  });
  if (run.terminalFailure?.terminal) {
    const terminalResult = resolveTerminalFailureResult(run.terminalFailure);
    log(terminalResult.finalResult);
    await fs.writeFile(paths.resultFile, terminalResult.finalResult);
    return terminalResult;
  }
  const { result, exitCode } = run;
  const planText = result.trim();
  if (exitCode !== 0 || !planText) {
    const msg = `Plan phase failed (exit ${exitCode}); worktree + branch preserved for inspection.`;
    log(msg);
    const finalResult = `${result}\n\n${msg}`;
    await fs.writeFile(paths.resultFile, finalResult);
    return { planFailed: true, finalResult };
  }
  log("Persisting plan to audit directory...");
  await fs.writeFile(paths.planFile, planText);
  return { planText };
}

export async function commitEngineeringChanges(
  ctx: EngineeringContext,
): Promise<{ dirty: boolean }> {
  const { item, worktreePath, deps, log } = ctx;
  const { git, claude, profile } = deps;
  const dirty = await git.isWorktreeDirty(worktreePath);
  if (dirty) {
    // Stage before summarising — `git diff HEAD` excludes untracked files, so
    // a fresh-from-scratch project (every file untracked) would otherwise feed
    // the commit-message model an empty diff. Staging is idempotent and
    // commitAll re-stages internally, so this is safe to repeat.
    await git.stageAll(worktreePath);
    log("Generating commit message...");
    const diff = await git.diffSummary(worktreePath);
    const commitMsg = await resolveEngineeringCommitMessage({
      claude,
      profile,
      item,
      diffSummary: diff,
      log,
    });
    log("Committing changes...");
    await git.commitAll(worktreePath, commitMsg);
    log("Committed.");
  } else {
    log("No worktree changes to commit.");
  }
  return { dirty };
}

export async function runEngineeringPreconditions(
  args: EngineeringPreconditionsArgs,
): Promise<{ ok: true; item: EngineeringItem } | { ok: false }> {
  const { item, agentName, hopperHome, deps, log } = args;
  const { fs } = deps;
  const preconditions = resolveEngineeringPreconditions(item);
  if (!preconditions.ok) {
    log(preconditions.reason);
    const { auditDir, resultFile } = resolveAuditPaths(item.id, hopperHome);
    await safeVoid(() => fs.ensureDir(auditDir), "Audit dir creation failed", log);
    await safeVoid(
      () => fs.writeFile(resultFile, preconditions.reason),
      "Result file write failed",
      log,
    );
    await safeRequeue(item.id, preconditions.reason, agentName, log);
    return { ok: false };
  }
  return { ok: true, item: preconditions.item };
}

export async function resolveWorkBranch(ctx: EngineeringContext): Promise<string> {
  const { item, deps, log } = ctx;
  const { claude, profile } = deps;
  let slug: string | null;
  const slugSource = resolveBranchSlugSource(item);
  if (slugSource.type === "cached") {
    slug = slugSource.slug;
    log(`Using cached branch slug: ${slug}`);
  } else {
    log("Generating branch slug...");
    slug = await resolveEngineeringBranchSlug({ claude, profile, item, log });
    if (slug) {
      await safePersistBranchSlug(item.id, slug, log);
    }
  }
  const workBranch = buildEngineeringBranchName(item.id, slug);
  log(`Work branch: ${workBranch}`);
  return workBranch;
}

export async function setupEngineeringWorktree(
  ctx: EngineeringContext,
  setup: { workingDir: string; branch: string; workBranch: string },
): Promise<{ ok: boolean }> {
  const { item, agentName, hopperHome, worktreePath, paths, deps, log } = ctx;
  const { workingDir, branch, workBranch } = setup;
  const { git, fs } = deps;
  try {
    await fs.ensureDir(paths.auditDir);
    await fs.ensureDir(join(hopperHome, "worktrees"));
    log(`Setting up worktree at ${worktreePath}...`);
    await orchestrateWorktreeSetup({
      git,
      repoDir: workingDir,
      branch,
      worktreePath,
      itemId: item.id,
      workBranchOverride: workBranch,
      log,
    });
    return { ok: true };
  } catch (e) {
    const reason = resolveWorktreeSetupFailureReason(e);
    log(`Pre-spawn failure — auto-requeueing: ${reason}`);
    await safeRequeue(item.id, reason, agentName, log);
    return { ok: false };
  }
}

export async function processEngineeringItem(args: ProcessEngineeringItemArgs): Promise<void> {
  const { item, agentName, hopperHome, deps, concurrency = 1 } = args;
  const log = createLogger(item.id, concurrency);
  const paths = resolveEngineeringAuditPaths(item.id, hopperHome);
  const worktreePath = join(hopperHome, "worktrees", item.id);

  const preconditions = await runEngineeringPreconditions({
    item,
    agentName,
    hopperHome,
    deps,
    log,
  });
  if (!preconditions.ok) return;
  const ctx: EngineeringContext = {
    item: preconditions.item,
    agentName,
    worktreePath,
    hopperHome,
    paths,
    deps,
    log,
  };

  logClaimBanner(ctx.item, log, [
    `Dir:     ${ctx.item.workingDir}`,
    `Branch:  ${ctx.item.branch}`,
    `Type:    engineering${ctx.item.agent ? ` (agent: ${ctx.item.agent})` : ""}`,
  ]);

  const workBranch = await resolveWorkBranch(ctx);

  const worktreeSetup = await setupEngineeringWorktree(ctx, {
    workingDir: ctx.item.workingDir,
    branch: ctx.item.branch,
    workBranch,
  });
  if (!worktreeSetup.ok) return;

  const planResult = await runPlanPhase(ctx);
  if ("terminalFailure" in planResult) {
    await finalizeCompletion({
      fs: deps.fs,
      resultFile: paths.resultFile,
      finalResult: planResult.finalResult,
      claimToken: ctx.item.claimToken,
      agentName,
      log,
    });
    return;
  }
  if ("planFailed" in planResult) {
    await finalizeFailure({
      claimToken: ctx.item.claimToken,
      agentName,
      finalResult: planResult.finalResult,
      log,
    });
    return;
  }
  const { planText } = planResult;

  const loopResult = await runExecuteValidateLoop({
    item: ctx.item,
    worktreePath,
    planText,
    paths,
    hopperHome,
    deps: { claude: deps.claude, fs: deps.fs, profile: deps.profile },
    log,
  });
  if (!loopResult.passed) {
    if (loopResult.terminalFailure?.terminal && loopResult.finalResult) {
      await finalizeCompletion({
        fs: deps.fs,
        resultFile: paths.resultFile,
        finalResult: loopResult.finalResult,
        claimToken: ctx.item.claimToken,
        agentName,
        log,
      });
      return;
    }
    // Execute exited non-zero or validate never passed within the retry
    // budget. This is terminal for the run: record `failed` so the item stops
    // holding its repo's serialization slot (a parked `in_progress` item used
    // to wedge every later queued item for the same workingDir). The worktree
    // + work branch stay exactly as the run left them.
    await finalizeFailure({
      claimToken: ctx.item.claimToken,
      agentName,
      finalResult:
        loopResult.finalResult ??
        buildEngineeringFailureResult(
          planText,
          loopResult.executeResults,
          loopResult.validateResults,
          loopResult.reason,
        ),
      log,
    });
    return;
  }

  const { dirty } = await commitEngineeringChanges(ctx);

  await finalizeWorktreeAndComplete({
    git: deps.git,
    repoDir: ctx.item.workingDir,
    worktreePath,
    workBranch,
    targetBranch: ctx.item.branch,
    shouldMerge: dirty,
    log,
    finalize: async (mergeNote) => {
      const combined = buildEngineeringTranscript(
        planText,
        loopResult.executeResults,
        loopResult.validateResults,
      );
      await finalizeCompletion({
        fs: deps.fs,
        resultFile: paths.resultFile,
        finalResult: combined + mergeNote,
        claimToken: ctx.item.claimToken,
        agentName,
        log,
      });
    },
  });
}
