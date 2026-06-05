import { join } from "node:path";
import {
  buildEngineeringFailureResult,
  buildEngineeringTranscript,
  resolveEngineeringCommitFallback,
  resolveEngineeringPreconditions,
} from "../engineering-workflow.ts";
import { toErrorMessage } from "../error-utils.ts";
import type { AgentRunner, SessionOptions } from "../gateways/agent-runner.ts";
import type { FsGateway } from "../gateways/fs-gateway.ts";
import type { GitGateway } from "../gateways/git-gateway.ts";
import { buildEngineeringBranchName } from "../git-workflow.ts";
import type { Profile } from "../profile.ts";
import type { ClaimedItem, Item, PhaseRecord } from "../store.ts";
import { recordItemPhase, setItemEngineeringBranchSlug } from "../store.ts";
import {
  buildBranchSlugPrompt,
  buildCommitMessagePrompt,
  buildExecuteOptions,
  buildExecutePrompt,
  buildExecuteRemediationPrompt,
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
} from "../task-type-workflow.ts";
import {
  type EngineeringAuditPaths,
  resolveAttemptAuditPath,
  resolveAuditPaths,
  resolveEngineeringAuditPaths,
} from "../worker-workflow.ts";
import {
  createLogger,
  type LogFn,
  logClaimBanner,
  logCompleteOutcome,
  mergeAndPush,
  orchestrateWorktreeSetup,
  StaleEngineeringBranchError,
  safeRequeue,
  safeVoid,
  teardownWorktree,
} from "./worker-shared.ts";

/**
 * Record a phase without ever throwing. Phase records are a visibility aid,
 * not a correctness-critical path — a transient I/O blip mid-flight must not
 * take down an otherwise-healthy engineering run.
 */
async function safeRecordPhase(itemId: string, record: PhaseRecord, log: LogFn): Promise<void> {
  return safeVoid(() => recordItemPhase(itemId, record), "Phase recording failed", log);
}

async function runPhase(
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

async function safePersistBranchSlug(itemId: string, slug: string, log: LogFn): Promise<void> {
  return safeVoid(() => setItemEngineeringBranchSlug(itemId, slug), "Slug persistence failed", log);
}

async function safeGenerateText(
  claude: AgentRunner,
  prompt: string,
  profile: Profile,
  label: string,
  log: LogFn,
): Promise<{ ok: true; text: string } | { ok: false }> {
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

async function resolveEngineeringBranchSlug(
  claude: AgentRunner,
  profile: Profile,
  item: Item,
  log: LogFn,
): Promise<string | null> {
  const prompt = buildBranchSlugPrompt(item.title, item.description);
  const result = await safeGenerateText(claude, prompt, profile, "Branch slug generation", log);
  if (!result.ok) return null;
  return normaliseBranchSlug(result.text);
}

async function resolveEngineeringCommitMessage(
  claude: AgentRunner,
  profile: Profile,
  item: Item,
  diffSummary: string,
  log: LogFn,
): Promise<string> {
  const prompt = buildCommitMessagePrompt(item.title, item.description, diffSummary);
  const result = await safeGenerateText(claude, prompt, profile, "Commit message generation", log);
  if (!result.ok) return item.title;
  return resolveEngineeringCommitFallback(item, result.text, 0);
}

const FALLBACK_UNCLASSIFIED_REASON = "fallback assessor could not classify (defaulting to FAIL)";

const fallbackFailOutcome = (): { passed: false; reason: string; fallbackUsed: true } => ({
  passed: false,
  reason: FALLBACK_UNCLASSIFIED_REASON,
  fallbackUsed: true,
});

export async function resolveValidateOutcomeWithFallback(
  exitCode: number,
  resultText: string,
  claude: Pick<AgentRunner, "generateText">,
  profile: Profile,
  log: LogFn = () => {},
): Promise<{ passed: boolean; reason: string; fallbackUsed?: boolean }> {
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
      return {
        passed: false,
        reason: "fallback assessor reported FAIL",
        fallbackUsed: true,
      };
    }

    log("Fallback assessor was UNCLEAR — defaulting to FAIL.");
    return fallbackFailOutcome();
  } catch {
    log("Fallback assessor threw — defaulting to FAIL.");
    return fallbackFailOutcome();
  }
}

export async function runPlanPhase(
  item: Item,
  worktreePath: string,
  paths: EngineeringAuditPaths,
  deps: { claude: AgentRunner; fs: FsGateway; profile: Profile },
  log: LogFn,
): Promise<{ planText: string } | null> {
  const { claude, fs, profile } = deps;
  log(`Plan phase (deep, plan mode, read-only)...\nAudit log: ${paths.planAuditFile}`);
  const { result, exitCode } = await runPhase(claude, profile, {
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
  const planText = result.trim();
  if (exitCode !== 0 || !planText) {
    const msg = `Plan phase failed (exit ${exitCode}); worktree + branch preserved for inspection.`;
    log(msg);
    await fs.writeFile(paths.resultFile, `${result}\n\n${msg}`);
    return null;
  }
  log("Persisting plan to audit directory...");
  await fs.writeFile(paths.planFile, planText);
  return { planText };
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
  deps: { claude: AgentRunner; fs: FsGateway; profile: Profile };
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
      executeResults[executeResults.length - 1] ?? "",
      validateResults[validateResults.length - 1] ?? "",
    );
    executeResults.push(executeAttempt.result);
    if (executeAttempt.exitCode !== 0) {
      const msg = `Execute phase attempt ${attempt} failed (exit ${executeAttempt.exitCode}); worktree + branch preserved.`;
      await writeEngineeringFailure(msg);
      return { passed: false, reason: msg, executeResults, validateResults };
    }

    const validateAttempt = await runValidateAttempt(ctx, attempt, maxAttempts);
    validateResults.push(validateAttempt.result);
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

export async function commitEngineeringChanges(
  item: Item,
  worktreePath: string,
  deps: { git: GitGateway; claude: AgentRunner; profile: Profile },
  log: LogFn,
): Promise<{ dirty: boolean }> {
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
    const commitMsg = await resolveEngineeringCommitMessage(claude, profile, item, diff, log);
    log("Committing changes...");
    await git.commitAll(worktreePath, commitMsg);
    log("Committed.");
  } else {
    log("No worktree changes to commit.");
  }
  return { dirty };
}

export interface TeardownContext {
  item: ClaimedItem;
  agentName: string;
  worktreePath: string;
  workBranch: string;
  dirty: boolean;
  planText: string;
  executeResults: readonly string[];
  validateResults: readonly string[];
  paths: EngineeringAuditPaths;
  deps: { git: GitGateway; fs: FsGateway };
  log: LogFn;
}

export async function teardownMergeAndComplete(ctx: TeardownContext): Promise<void> {
  const {
    item,
    agentName,
    worktreePath,
    workBranch,
    dirty,
    planText,
    executeResults,
    validateResults,
    paths,
    deps,
    log,
  } = ctx;
  const { git, fs } = deps;
  await teardownWorktree(git, item.workingDir as string, worktreePath, log);

  let mergeNote = "";
  if (dirty) {
    mergeNote = await mergeAndPush(git, item, workBranch, log);
  }

  const combined = buildEngineeringTranscript(planText, executeResults, validateResults);
  const finalResult = combined + mergeNote;
  await fs.writeFile(paths.resultFile, finalResult);

  await logCompleteOutcome(item.claimToken, agentName, finalResult, log);
}

export async function processEngineeringItem(
  item: ClaimedItem,
  agentName: string,
  hopperHome: string,
  deps: { git: GitGateway; claude: AgentRunner; fs: FsGateway; profile: Profile },
  concurrency: number = 1,
): Promise<void> {
  const { git, claude, fs, profile } = deps;
  const log = createLogger(item.id, concurrency);

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
    return;
  }
  const { workingDir, branch } = preconditions;

  logClaimBanner(item, log, [
    `Dir:     ${workingDir}`,
    `Branch:  ${branch}`,
    `Type:    engineering${item.agent ? ` (agent: ${item.agent})` : ""}`,
  ]);

  const paths = resolveEngineeringAuditPaths(item.id, hopperHome);
  const worktreePath = join(hopperHome, "worktrees", item.id);

  // Resolve branch slug — use cached value when available so re-claims always
  // produce the same work-branch name regardless of LLM non-determinism.
  let slug: string | null;
  const slugSource = resolveBranchSlugSource(item);
  if (slugSource.type === "cached") {
    slug = slugSource.slug;
    log(`Using cached branch slug: ${slug}`);
  } else {
    log("Generating branch slug...");
    slug = await resolveEngineeringBranchSlug(claude, profile, item, log);
    if (slug) {
      await safePersistBranchSlug(item.id, slug, log);
    }
  }
  const workBranch = buildEngineeringBranchName(item.id, slug);
  log(`Work branch: ${workBranch}`);

  // Pre-spawn setup: auto-requeue on failure so the item doesn't get stuck
  // in `in_progress`. Post-spawn failures propagate to the worker loop's
  // last-resort safety net.
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
  } catch (e) {
    const reason =
      e instanceof StaleEngineeringBranchError
        ? `Stale branch: ${e.message}`
        : `Worktree setup failed: ${toErrorMessage(e)}`;
    log(`Pre-spawn failure — auto-requeueing: ${reason}`);
    await safeRequeue(item.id, reason, agentName, log);
    return;
  }

  // --- Plan phase -------------------------------------------------------
  const planResult = await runPlanPhase(item, worktreePath, paths, { claude, fs, profile }, log);
  if (!planResult) return;
  const { planText } = planResult;

  // --- Execute / Validate loop ----------------------------------------
  const loopResult = await runExecuteValidateLoop({
    item,
    worktreePath,
    planText,
    paths,
    hopperHome,
    deps: { claude, fs, profile },
    log,
  });
  if (!loopResult.passed) return;

  // --- Commit (Hopper + Haiku) -----------------------------------------
  const { dirty } = await commitEngineeringChanges(
    item,
    worktreePath,
    { git, claude, profile },
    log,
  );

  // --- Worktree teardown + merge/push + complete -----------------------
  await teardownMergeAndComplete({
    item,
    agentName,
    worktreePath,
    workBranch,
    dirty,
    planText,
    executeResults: loopResult.executeResults,
    validateResults: loopResult.validateResults,
    paths,
    deps: { git, fs },
    log,
  });
}
