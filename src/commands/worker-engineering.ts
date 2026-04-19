import { join } from "node:path";
import {
  buildEngineeringFailureResult,
  buildEngineeringTranscript,
  resolveEngineeringCommitFallback,
} from "../engineering-workflow.ts";
import type { ClaudeGateway } from "../gateways/claude-gateway.ts";
import type { FsGateway } from "../gateways/fs-gateway.ts";
import type { GitGateway } from "../gateways/git-gateway.ts";
import { buildEngineeringBranchName } from "../git-workflow.ts";
import type { ClaimedItem, Item, PhaseRecord } from "../store.ts";
import { completeItem, recordItemPhase } from "../store.ts";
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
  mergeAndPush,
  orchestrateWorktreeSetup,
  teardownWorktree,
} from "./worker-shared.ts";

/**
 * Record a phase without ever throwing. Phase records are a visibility aid,
 * not a correctness-critical path — a transient I/O blip mid-flight must not
 * take down an otherwise-healthy engineering run.
 */
async function safeRecordPhase(itemId: string, record: PhaseRecord): Promise<void> {
  try {
    await recordItemPhase(itemId, record);
  } catch {
    // intentional: phase recording is best-effort
  }
}

async function resolveEngineeringBranchSlug(
  claude: ClaudeGateway,
  item: Item,
): Promise<string | null> {
  try {
    const prompt = buildBranchSlugPrompt(item.title, item.description);
    const { exitCode, text } = await claude.generateText(prompt, "haiku");
    if (exitCode !== 0) return null;
    return normaliseBranchSlug(text);
  } catch {
    return null;
  }
}

async function resolveEngineeringCommitMessage(
  claude: ClaudeGateway,
  item: Item,
  diffSummary: string,
): Promise<string> {
  try {
    const prompt = buildCommitMessagePrompt(item.title, item.description, diffSummary);
    const { exitCode, text } = await claude.generateText(prompt, "haiku");
    return resolveEngineeringCommitFallback(item, text, exitCode);
  } catch {
    return item.title;
  }
}

export async function runPlanPhase(
  item: Item,
  worktreePath: string,
  paths: EngineeringAuditPaths,
  deps: { claude: ClaudeGateway; fs: FsGateway },
  log: LogFn,
): Promise<{ planText: string } | null> {
  const { claude, fs } = deps;
  log(`Plan phase (opus, plan mode, read-only)...\nAudit log: ${paths.planAuditFile}`);
  const planPrompt = buildPlanPrompt(item);
  const planStartedAt = new Date().toISOString();
  const planRun = await claude.runSession(
    planPrompt,
    worktreePath,
    paths.planAuditFile,
    buildPlanOptions(),
  );
  const planText = planRun.result.trim();
  await safeRecordPhase(item.id, {
    name: "plan",
    startedAt: planStartedAt,
    endedAt: new Date().toISOString(),
    exitCode: planRun.exitCode,
  });
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

export async function runExecuteValidateLoop(
  item: ClaimedItem,
  worktreePath: string,
  planText: string,
  paths: EngineeringAuditPaths,
  hopperHome: string,
  deps: { claude: ClaudeGateway; fs: FsGateway },
  log: LogFn,
): Promise<ExecuteValidateResult> {
  const { claude, fs } = deps;
  // One execute → validate attempt, then up to `maxRetries` remediation
  // attempts when validate reports FAIL. Each attempt writes its own
  // per-attempt audit file and records phase entries so `hopper show`
  // reflects progress in real time.
  const maxRetries = item.retries ?? 1;
  const maxAttempts = 1 + maxRetries;
  let attempt = 0;
  let outcome: { passed: boolean; reason: string } = { passed: false, reason: "not run" };
  const executeResults: string[] = [];
  const validateResults: string[] = [];

  while (attempt < maxAttempts) {
    attempt += 1;

    // --- Execute (initial or remediation) ---------------------------------
    const executeAuditPath = resolveAttemptAuditPath(item.id, hopperHome, "execute", attempt);
    const isRemediation = attempt > 1;
    log(
      `Execute phase attempt ${attempt}/${maxAttempts} (sonnet${
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
    const executeRun = await claude.runSession(
      executePrompt,
      worktreePath,
      executeAuditPath,
      buildExecuteOptions(item.agent),
    );
    executeResults.push(executeRun.result);
    await safeRecordPhase(item.id, {
      name: "execute",
      startedAt: executeStartedAt,
      endedAt: new Date().toISOString(),
      exitCode: executeRun.exitCode,
      attempt,
    });
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
      `Validate phase attempt ${attempt}/${maxAttempts} (opus, read-only git)...\nAudit log: ${validateAuditPath}`,
    );
    const validateStartedAt = new Date().toISOString();
    const validateRun = await claude.runSession(
      buildValidatePrompt(item, planText),
      worktreePath,
      validateAuditPath,
      buildValidateOptions(),
    );
    validateResults.push(validateRun.result);
    outcome = resolveValidateOutcome(validateRun.exitCode, validateRun.result);
    await safeRecordPhase(item.id, {
      name: "validate",
      startedAt: validateStartedAt,
      endedAt: new Date().toISOString(),
      exitCode: validateRun.exitCode,
      passed: outcome.passed,
      attempt,
    });

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
  deps: { git: GitGateway; claude: ClaudeGateway },
  log: LogFn,
): Promise<{ dirty: boolean }> {
  const { git, claude } = deps;
  const dirty = await git.isWorktreeDirty(worktreePath);
  if (dirty) {
    log("Generating commit message...");
    const diff = await git.diffSummary(worktreePath);
    const commitMsg = await resolveEngineeringCommitMessage(claude, item, diff);
    log("Committing changes...");
    await git.commitAll(worktreePath, commitMsg);
    log("Committed.");
  } else {
    log("No worktree changes to commit.");
  }
  return { dirty };
}

export async function teardownMergeAndComplete(
  item: ClaimedItem,
  agentName: string,
  worktreePath: string,
  workBranch: string,
  dirty: boolean,
  planText: string,
  executeResults: readonly string[],
  validateResults: readonly string[],
  paths: EngineeringAuditPaths,
  deps: { git: GitGateway; fs: FsGateway },
  log: LogFn,
): Promise<void> {
  const { git, fs } = deps;
  await teardownWorktree(git, item.workingDir as string, worktreePath, log);

  let mergeNote = "";
  if (dirty) {
    mergeNote = await mergeAndPush(git, item, workBranch, log);
  }

  const combined = buildEngineeringTranscript(planText, executeResults, validateResults);
  const finalResult = combined + mergeNote;
  await fs.writeFile(paths.resultFile, finalResult);

  log("Marking item complete...");
  const { completed, recurred } = await completeItem(item.claimToken, agentName, finalResult);
  log(`Completed: ${completed.title}`);
  if (recurred) {
    log(
      `Re-queued: ${completed.title} (next run: ${recurred.scheduledAt ? new Date(recurred.scheduledAt).toLocaleString() : "unknown"})`,
    );
  }
}

export async function processEngineeringItem(
  item: ClaimedItem,
  agentName: string,
  hopperHome: string,
  deps: { git: GitGateway; claude: ClaudeGateway; fs: FsGateway },
  concurrency: number = 1,
): Promise<void> {
  const { git, claude, fs } = deps;
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

  log(`Claimed: ${item.title}`);
  log(`Token:   ${item.claimToken}`);
  log(`ID:      ${item.id}`);
  log(`Dir:     ${item.workingDir}`);
  log(`Branch:  ${item.branch}`);
  log(`Type:    engineering${item.agent ? ` (agent: ${item.agent})` : ""}`);

  const paths = resolveEngineeringAuditPaths(item.id, hopperHome);
  await fs.ensureDir(paths.auditDir);

  const worktreePath = join(hopperHome, "worktrees", item.id);
  await fs.ensureDir(join(hopperHome, "worktrees"));

  log("Generating branch slug...");
  const slug = await resolveEngineeringBranchSlug(claude, item);
  const workBranch = buildEngineeringBranchName(item.id, slug);
  log(`Work branch: ${workBranch}`);

  let worktreeLivePath: string | undefined;
  try {
    log(`Setting up worktree at ${worktreePath}...`);
    await orchestrateWorktreeSetup(
      git,
      item.workingDir,
      item.branch,
      worktreePath,
      item.id,
      workBranch,
    );
    worktreeLivePath = worktreePath;

    // --- Plan phase -------------------------------------------------------
    const planResult = await runPlanPhase(item, worktreePath, paths, { claude, fs }, log);
    if (!planResult) return;
    const { planText } = planResult;

    // --- Execute / Validate loop ----------------------------------------
    const loopResult = await runExecuteValidateLoop(
      item,
      worktreePath,
      planText,
      paths,
      hopperHome,
      { claude, fs },
      log,
    );
    if (!loopResult.passed) return;

    // --- Commit (Hopper + Haiku) -----------------------------------------
    const { dirty } = await commitEngineeringChanges(item, worktreePath, { git, claude }, log);

    // --- Worktree teardown + merge/push + complete -----------------------
    await teardownMergeAndComplete(
      item,
      agentName,
      worktreePath,
      workBranch,
      dirty,
      planText,
      loopResult.executeResults,
      loopResult.validateResults,
      paths,
      { git, fs },
      log,
    );
    worktreeLivePath = undefined;
  } finally {
    // Only tear down if the flow didn't already clean up the worktree. A live
    // path here means we aborted mid-flight; the worktree may be in an
    // intermediate state so leave it for inspection — the `worktrees` dir is
    // shared with the user's review workflow, not a temp dir.
    void worktreeLivePath;
  }
}
