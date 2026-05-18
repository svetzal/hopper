import { join } from "node:path";
import {
  buildEngineeringFailureResult,
  buildEngineeringTranscript,
  resolveEngineeringCommitFallback,
} from "../engineering-workflow.ts";
import { toErrorMessage } from "../error-utils.ts";
import type { ClaudeGateway } from "../gateways/claude-gateway.ts";
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
  buildValidateOptions,
  buildValidatePrompt,
  normaliseBranchSlug,
  resolveValidateOutcomeWithFallback,
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
async function safeRecordPhase(itemId: string, record: PhaseRecord, log?: LogFn): Promise<void> {
  return safeVoid(() => recordItemPhase(itemId, record), "Phase recording failed", log);
}

async function safePersistBranchSlug(itemId: string, slug: string, log?: LogFn): Promise<void> {
  return safeVoid(() => setItemEngineeringBranchSlug(itemId, slug), "Slug persistence failed", log);
}

async function resolveEngineeringBranchSlug(
  claude: ClaudeGateway,
  profile: Profile,
  item: Item,
  log?: LogFn,
): Promise<string | null> {
  try {
    const prompt = buildBranchSlugPrompt(item.title, item.description);
    const { exitCode, text } = await claude.generateText(prompt, "fast", { profile });
    if (exitCode !== 0) return null;
    return normaliseBranchSlug(text);
  } catch (e) {
    log?.(`Branch slug generation failed: ${toErrorMessage(e)}`);
    return null;
  }
}

async function resolveEngineeringCommitMessage(
  claude: ClaudeGateway,
  profile: Profile,
  item: Item,
  diffSummary: string,
  log?: LogFn,
): Promise<string> {
  try {
    const prompt = buildCommitMessagePrompt(item.title, item.description, diffSummary);
    const { exitCode, text } = await claude.generateText(prompt, "fast", { profile });
    return resolveEngineeringCommitFallback(item, text, exitCode);
  } catch (e) {
    log?.(`Commit message generation failed, using title: ${toErrorMessage(e)}`);
    return item.title;
  }
}

export async function runPlanPhase(
  item: Item,
  worktreePath: string,
  paths: EngineeringAuditPaths,
  deps: { claude: ClaudeGateway; fs: FsGateway; profile: Profile },
  log: LogFn,
): Promise<{ planText: string } | null> {
  const { claude, fs, profile } = deps;
  log(`Plan phase (deep, plan mode, read-only)...\nAudit log: ${paths.planAuditFile}`);
  const planPrompt = buildPlanPrompt(item);
  const planStartedAt = new Date().toISOString();
  const planRun = await claude.runSession(planPrompt, worktreePath, paths.planAuditFile, {
    ...buildPlanOptions(),
    profile,
  });
  const planText = planRun.result.trim();
  await safeRecordPhase(
    item.id,
    {
      name: "plan",
      startedAt: planStartedAt,
      endedAt: new Date().toISOString(),
      exitCode: planRun.exitCode,
    },
    log,
  );
  if (planRun.exitCode !== 0 || !planText) {
    const msg = `Plan phase failed (exit ${planRun.exitCode}); worktree + branch preserved for inspection.`;
    log(msg);
    await fs.writeFile(paths.resultFile, `${planRun.result}\n\n${msg}`);
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
  deps: { claude: ClaudeGateway; fs: FsGateway; profile: Profile };
  log: LogFn;
}

export async function runExecuteValidateLoop(
  ctx: ExecuteValidateContext,
): Promise<ExecuteValidateResult> {
  const { item, worktreePath, planText, paths, hopperHome, deps, log } = ctx;
  const { claude, fs, profile } = deps;
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

  while (attempt < maxAttempts) {
    attempt += 1;

    // --- Execute (initial or remediation) ---------------------------------
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
          executeResults[executeResults.length - 1] ?? "",
          validateResults[validateResults.length - 1] ?? "",
          attempt,
        )
      : buildExecutePrompt(item, planText);
    const executeStartedAt = new Date().toISOString();
    const executeRun = await claude.runSession(executePrompt, worktreePath, executeAuditPath, {
      ...buildExecuteOptions(item.agent),
      profile,
    });
    executeResults.push(executeRun.result);
    await safeRecordPhase(
      item.id,
      {
        name: "execute",
        startedAt: executeStartedAt,
        endedAt: new Date().toISOString(),
        exitCode: executeRun.exitCode,
        attempt,
      },
      log,
    );
    if (executeRun.exitCode !== 0) {
      const msg = `Execute phase attempt ${attempt} failed (exit ${executeRun.exitCode}); worktree + branch preserved.`;
      log(msg);
      await fs.writeFile(
        paths.resultFile,
        buildEngineeringFailureResult(planText, executeResults, validateResults, msg),
      );
      return { passed: false, reason: msg, executeResults, validateResults };
    }

    // --- Validate ----------------------------------------------------------
    const validateAuditPath = resolveAttemptAuditPath(item.id, hopperHome, "validate", attempt);
    log(
      `Validate phase attempt ${attempt}/${maxAttempts} (deep, read-only git)...\nAudit log: ${validateAuditPath}`,
    );
    const validateStartedAt = new Date().toISOString();
    const validateRun = await claude.runSession(
      buildValidatePrompt(item, planText),
      worktreePath,
      validateAuditPath,
      { ...buildValidateOptions(), profile },
    );
    validateResults.push(validateRun.result);
    outcome = await resolveValidateOutcomeWithFallback(
      validateRun.exitCode,
      validateRun.result,
      claude,
      profile,
      log,
    );
    await safeRecordPhase(
      item.id,
      {
        name: "validate",
        startedAt: validateStartedAt,
        endedAt: new Date().toISOString(),
        exitCode: validateRun.exitCode,
        passed: outcome.passed,
        attempt,
        ...(outcome.fallbackUsed ? { fallbackUsed: true } : {}),
      },
      log,
    );

    if (outcome.passed) break;

    if (attempt < maxAttempts) {
      log(
        `Validate attempt ${attempt} did not pass (${outcome.reason}); remediating (attempt ${attempt + 1}/${maxAttempts})...`,
      );
    }
  }

  if (!outcome.passed) {
    const msg = `Validate did not pass after ${attempt}/${maxAttempts} attempt(s) (${outcome.reason}); worktree + branch preserved.`;
    log(msg);
    await fs.writeFile(
      paths.resultFile,
      buildEngineeringFailureResult(planText, executeResults, validateResults, msg),
    );
    return { passed: false, reason: outcome.reason, executeResults, validateResults };
  }

  return { passed: true, reason: outcome.reason, executeResults, validateResults };
}

export async function commitEngineeringChanges(
  item: Item,
  worktreePath: string,
  deps: { git: GitGateway; claude: ClaudeGateway; profile: Profile },
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
  deps: { git: GitGateway; claude: ClaudeGateway; fs: FsGateway; profile: Profile },
  concurrency: number = 1,
): Promise<void> {
  const { git, claude, fs, profile } = deps;
  const log = createLogger(item.id, concurrency);

  if (!item.workingDir || !item.branch) {
    // Engineering items need both to work inside an isolated worktree. The add
    // command enforces this on enqueue, but guard here belt-and-suspenders.
    const message = "Engineering items require --dir and --branch; cannot run.";
    log(message);
    const { auditDir, resultFile } = resolveAuditPaths(item.id, hopperHome);
    await fs.ensureDir(auditDir);
    await fs.writeFile(resultFile, message);
    log(`Use 'hopper requeue ${item.id} --reason "..."' to retry.`);
    return;
  }

  logClaimBanner(item, log, [
    `Dir:     ${item.workingDir}`,
    `Branch:  ${item.branch}`,
    `Type:    engineering${item.agent ? ` (agent: ${item.agent})` : ""}`,
  ]);

  const paths = resolveEngineeringAuditPaths(item.id, hopperHome);
  await fs.ensureDir(paths.auditDir);

  const worktreePath = join(hopperHome, "worktrees", item.id);
  await fs.ensureDir(join(hopperHome, "worktrees"));

  // Resolve branch slug — use cached value when available so re-claims always
  // produce the same work-branch name regardless of LLM non-determinism.
  let slug: string | null;
  if (item.engineeringBranchSlug) {
    slug = item.engineeringBranchSlug;
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
    log(`Setting up worktree at ${worktreePath}...`);
    await orchestrateWorktreeSetup({
      git,
      repoDir: item.workingDir,
      branch: item.branch,
      worktreePath,
      itemId: item.id,
      workBranchOverride: workBranch,
      log,
    });
  } catch (err) {
    const reason =
      err instanceof StaleEngineeringBranchError
        ? `Stale branch: ${err.message}`
        : `Worktree setup failed: ${toErrorMessage(err)}`;
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
