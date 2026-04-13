import { homedir } from "node:os";
import { join } from "node:path";
import type { ParsedArgs } from "../cli.ts";
import { shortId } from "../format.ts";
import type { ClaudeGateway } from "../gateways/claude-gateway.ts";
import { createClaudeGateway } from "../gateways/claude-gateway.ts";
import type { FsGateway } from "../gateways/fs-gateway.ts";
import { createFsGateway } from "../gateways/fs-gateway.ts";
import type { GitGateway, MergeOutcome } from "../gateways/git-gateway.ts";
import { createGitGateway } from "../gateways/git-gateway.ts";
import type { ShellGateway } from "../gateways/shell-gateway.ts";
import { createShellGateway } from "../gateways/shell-gateway.ts";
import {
  buildEngineeringBranchName,
  buildWorkBranchName,
  resolveBranchSetup,
  resolveFfResult,
  resolveMergeCommitResult,
  resolveMergeStep,
} from "../git-workflow.ts";
import type { ClaimedItem, Item, PhaseRecord } from "../store.ts";
import { claimNextItem, completeItem, recordItemPhase, requeueItem } from "../store.ts";
import {
  buildBranchSlugPrompt,
  buildCommitMessagePrompt,
  buildExecuteOptions,
  buildExecutePrompt,
  buildExecuteRemediationPrompt,
  buildInvestigationOptions,
  buildInvestigationPrompt,
  buildPlanOptions,
  buildPlanPrompt,
  buildValidateOptions,
  buildValidatePrompt,
  normaliseBranchSlug,
  normaliseCommitMessage,
  resolveValidateOutcome,
} from "../task-type-workflow.ts";
import {
  buildCommitMessage,
  buildTaskPrompt,
  type EngineeringAuditPaths,
  resolveAttemptAuditPath,
  resolveAuditPaths,
  resolveAutoRequeue,
  resolveCompletionAction,
  resolveEngineeringAuditPaths,
  resolveLoopAction,
  resolveMergeAction,
  resolvePostClaimLoopAction,
  resolvePostClaudeAction,
  resolveShutdownAction,
  resolveWorkerConfig,
  resolveWorkSetup,
  type WorkerConfig,
} from "../worker-workflow.ts";

export interface WorkerDeps {
  git?: GitGateway;
  claude?: ClaudeGateway;
  fs?: FsGateway;
  shell?: ShellGateway;
}

type LogFn = (message: string) => void;

function createLogger(itemId: string, concurrency: number): LogFn {
  if (concurrency > 1) {
    const prefix = `[${shortId(itemId)}]`;
    return (message: string) => console.log(`${prefix} ${message}`);
  }
  return (message: string) => console.log(message);
}

async function orchestrateWorktreeSetup(
  git: GitGateway,
  repoDir: string,
  branch: string,
  worktreePath: string,
  itemId: string,
  workBranchOverride?: string,
): Promise<string> {
  const localExists = await git.branchExists(repoDir, branch);
  const remoteExists = await git.remoteBranchExists(repoDir, branch);
  const branchAction = resolveBranchSetup(branch, { localExists, remoteExists });

  switch (branchAction.type) {
    case "track-remote":
      await git.createTrackingBranch(repoDir, branch, branchAction.remoteRef);
      break;
    case "create-from-head":
      await git.createBranch(repoDir, branch);
      break;
    case "use-existing":
      break;
  }

  const workBranch = workBranchOverride ?? buildWorkBranchName(itemId);
  await git.createWorktree(repoDir, worktreePath, workBranch, branch);
  return workBranch;
}

async function orchestrateMerge(
  git: GitGateway,
  repoDir: string,
  targetBranch: string,
  workBranch: string,
): Promise<MergeOutcome> {
  const currentBranch = await git.getCurrentBranch(repoDir);
  const mergeCtx = { workBranch, targetBranch };
  const initialStep = resolveMergeStep(currentBranch, targetBranch);

  let restoreBranch: string | undefined;
  if (initialStep.type === "checkout-and-attempt-ff") {
    restoreBranch = initialStep.originalBranch;
    await git.checkout(repoDir, targetBranch);
  }

  try {
    const ffExit = await git.mergeFastForward(repoDir, workBranch);
    const ffResult = resolveFfResult(ffExit, mergeCtx);

    if (ffResult.type === "ff-succeeded") {
      await git.deleteBranch(repoDir, workBranch);
      return ffResult.outcome;
    }

    const mergeExit = await git.mergeCommit(repoDir, workBranch);
    const mcResult = resolveMergeCommitResult(mergeExit, mergeCtx);

    if (mcResult.type === "merge-commit-succeeded") {
      await git.deleteBranch(repoDir, workBranch);
      return mcResult.outcome;
    }

    await git.mergeAbort(repoDir);
    if (mcResult.type !== "conflict-abort") {
      throw new Error(`Unexpected merge step type: ${mcResult.type}`);
    }
    return mcResult.outcome;
  } finally {
    if (restoreBranch) {
      await git.checkout(repoDir, restoreBranch);
    }
  }
}

async function handleCompletion(
  item: ClaimedItem,
  agentName: string,
  exitCode: number,
  result: string,
  mergeNote: string,
  workBranch: string | undefined,
  fs: FsGateway,
  resultFile: string,
  log: LogFn,
): Promise<void> {
  const { action, result: finalResult } = resolveCompletionAction(exitCode, result, mergeNote);
  await fs.writeFile(resultFile, finalResult);

  const outputLabel = item.command ? "Command" : "Claude";
  log(`--- ${outputLabel} Output ---`);
  log(result);
  if (mergeNote) log(mergeNote.trim());
  log("---------------------");

  if (action === "complete") {
    log("Marking item complete...");
    const { completed, recurred } = await completeItem(item.claimToken, agentName, finalResult);
    log(`Completed: ${completed.title}`);
    if (recurred) {
      log(
        `Re-queued: ${completed.title} (next run: ${recurred.scheduledAt ? new Date(recurred.scheduledAt).toLocaleString() : "unknown"})`,
      );
    }
  } else {
    const sessionLabel = item.command ? "Command" : "Claude session";
    log(`${sessionLabel} failed for: ${item.title} (${item.id})`);
    if (workBranch) log(`Work branch ${workBranch} preserved for review.`);

    // A non-zero exit with no captured result almost always means Claude
    // never ran (argv / environment / startup error). Auto-requeue those so
    // the queue heals without operator intervention. Items that produced any
    // real result stay wedged at in_progress on purpose — there's probably
    // something worth reading before the operator decides whether to retry.
    const autoRequeue = resolveAutoRequeue(exitCode, result);
    if (autoRequeue.shouldAutoRequeue) {
      try {
        await requeueItem(item.id, autoRequeue.reason, agentName);
        log(`Auto-requeued: ${item.title} (${autoRequeue.reason}).`);
      } catch (err) {
        log(`Auto-requeue failed: ${err instanceof Error ? err.message : String(err)}`);
        log(`Use 'hopper requeue ${item.id} --reason "..."' to retry.`);
      }
    } else {
      log(`Use 'hopper requeue ${item.id} --reason "..."' to retry.`);
    }
  }
}

async function mergeAndPush(
  git: GitGateway,
  item: Item,
  workBranch: string,
  log: LogFn,
): Promise<string> {
  const targetBranch = item.branch as string;
  const repoDir = item.workingDir as string;
  log(`Merging ${workBranch} → ${targetBranch}...`);
  const mergeResult = await orchestrateMerge(git, repoDir, targetBranch, workBranch);
  log(mergeResult.message);
  let mergeNote = `\n\n---\nMerge: ${mergeResult.message}`;
  if (mergeResult.success) {
    const pushResult = await git.push(repoDir, targetBranch);
    log(pushResult.message);
    if (!pushResult.success) {
      mergeNote += `\nPush: ${pushResult.message}`;
    }
    const tagResult = await git.pushTags(repoDir);
    if (tagResult.success) {
      log(tagResult.message);
    } else {
      log(`Warning: ${tagResult.message}`);
      mergeNote += `\nTags: ${tagResult.message}`;
    }
  } else {
    log(`Action required: manually merge branch ${workBranch}.`);
  }
  return mergeNote;
}

async function teardownWorktree(
  git: GitGateway,
  repoDir: string,
  worktreePath: string,
  log: LogFn,
): Promise<void> {
  log("Removing worktree...");
  await git.worktreeRemove(repoDir, worktreePath);
}

async function commitWorktreeChanges(
  git: GitGateway,
  worktreePath: string,
  item: Item,
  result: string,
  log: LogFn,
): Promise<void> {
  const dirty = await git.isWorktreeDirty(worktreePath);
  const { shouldCommit } = resolvePostClaudeAction(true, dirty);
  if (shouldCommit) {
    const commitMsg = buildCommitMessage(item, result);
    log("Committing changes...");
    await git.commitAll(worktreePath, commitMsg);
    log("Committed.");
  }
}

async function executeWork(
  item: Item,
  workDir: string | undefined,
  auditFile: string,
  deps: { claude: ClaudeGateway; shell: ShellGateway },
  log: LogFn,
): Promise<{ exitCode: number; result: string }> {
  const { claude, shell } = deps;
  if (item.command) {
    log(`Starting command...\nAudit log: ${auditFile}`);
    return shell.runCommand(item.command, workDir ?? process.cwd(), auditFile);
  }
  if (item.type === "investigation") {
    const prompt = buildInvestigationPrompt(item);
    const options = buildInvestigationOptions();
    log(`Starting investigation session (opus, read-only)...\nAudit log: ${auditFile}`);
    return claude.runSession(prompt, workDir ?? process.cwd(), auditFile, options);
  }
  const prompt = buildTaskPrompt(item);
  log(`Starting Claude session...\nAudit log: ${auditFile}`);
  return claude.runSession(prompt, workDir ?? process.cwd(), auditFile);
}

// ---------------------------------------------------------------------------
// Engineering type: phased orchestration
// ---------------------------------------------------------------------------

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

/**
 * Compose the result markdown for an engineering attempt transcript, with a
 * section per execute/validate pair so coordinators reviewing `hopper show`
 * or `<id>-result.md` can see how each remediation attempt unfolded.
 */
function buildEngineeringTranscript(
  planText: string,
  executeResults: readonly string[],
  validateResults: readonly string[],
): string {
  const sections: string[] = ["## Plan", planText];
  const pairs = Math.max(executeResults.length, validateResults.length);
  for (let i = 0; i < pairs; i++) {
    const label = pairs > 1 ? ` (attempt ${i + 1})` : "";
    if (executeResults[i] !== undefined) {
      sections.push(`## Execute${label}`, executeResults[i] ?? "");
    }
    if (validateResults[i] !== undefined) {
      sections.push(`## Validate${label}`, validateResults[i] ?? "");
    }
  }
  return sections.join("\n\n");
}

function buildEngineeringFailureResult(
  planText: string,
  executeResults: readonly string[],
  validateResults: readonly string[],
  failureMessage: string,
): string {
  return `${buildEngineeringTranscript(planText, executeResults, validateResults)}\n\n${failureMessage}`;
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
    if (exitCode === 0 && text.trim()) {
      return normaliseCommitMessage(text);
    }
  } catch {
    // fall through to deterministic fallback
  }
  // Deterministic fallback: the legacy title/summary commit message shape so
  // engineering items still commit cleanly when Haiku is unavailable.
  return item.title;
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

async function processEngineeringItem(
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

export async function processItem(
  item: ClaimedItem,
  agentName: string,
  hopperHome: string,
  deps: { git: GitGateway; claude: ClaudeGateway; fs: FsGateway; shell: ShellGateway },
  concurrency: number = 1,
): Promise<void> {
  if (item.type === "engineering" && !item.command) {
    return processEngineeringItem(item, agentName, hopperHome, deps, concurrency);
  }
  const { git, claude, fs, shell } = deps;
  const log = createLogger(item.id, concurrency);

  log(`Claimed: ${item.title}`);
  log(`Token:   ${item.claimToken}`);
  log(`ID:      ${item.id}`);
  if (item.workingDir) log(`Dir:     ${item.workingDir}`);
  if (item.branch) log(`Branch:  ${item.branch}`);
  if (item.command) log(`Command: ${item.command}`);

  const { auditDir, auditFile, resultFile } = resolveAuditPaths(item.id, hopperHome);
  await fs.ensureDir(auditDir);

  const workSetup = resolveWorkSetup(item, hopperHome);

  let worktreePath: string | undefined;
  let workBranch: string | undefined;
  let workDir: string | undefined;

  try {
    if (workSetup.type === "worktree") {
      worktreePath = workSetup.worktreePath;
      await fs.ensureDir(join(hopperHome, "worktrees"));
      log(`Setting up worktree at ${worktreePath}...`);
      workBranch = await orchestrateWorktreeSetup(
        git,
        workSetup.repoDir,
        workSetup.branch,
        worktreePath,
        item.id,
      );
      log(`Work branch: ${workBranch}`);
      workDir = worktreePath;
    } else if (workSetup.type === "existing-dir") {
      workDir = workSetup.dir;
    }

    const { exitCode, result } = await executeWork(
      item,
      workDir,
      auditFile,
      { claude, shell },
      log,
    );

    if (worktreePath) {
      await commitWorktreeChanges(git, worktreePath, item, result, log);
    }

    if (worktreePath && item.workingDir) {
      await teardownWorktree(git, item.workingDir, worktreePath, log);
      worktreePath = undefined;
    }

    const { shouldMerge } = resolveMergeAction(exitCode, workBranch, item);
    const mergeNote =
      shouldMerge && workBranch && item.workingDir && item.branch
        ? await mergeAndPush(git, item, workBranch, log)
        : "";

    await handleCompletion(
      item,
      agentName,
      exitCode,
      result,
      mergeNote,
      workBranch,
      fs,
      resultFile,
      log,
    );
  } finally {
    // Belt-and-suspenders: clean up worktree if something threw mid-flight
    if (worktreePath && item.workingDir) {
      await git.worktreeRemove(item.workingDir, worktreePath);
    }
  }
}

export interface WorkerLoopDeps {
  claimNext: (agentName: string) => Promise<ClaimedItem | null | undefined>;
  processItem: (
    item: ClaimedItem,
    agentName: string,
    hopperHome: string,
    deps: { git: GitGateway; claude: ClaudeGateway; fs: FsGateway; shell: ShellGateway },
    concurrency: number,
  ) => Promise<void>;
  sleep: (ms: number) => Promise<{ cancelled: boolean }>;
  log: (message: string) => void;
  onSignal: (signal: "SIGINT" | "SIGTERM", handler: () => void) => void;
}

function createCancellableSleep(): {
  sleep: (ms: number) => Promise<{ cancelled: boolean }>;
  cancel: () => void;
} {
  let cancelFn: (() => void) | undefined;

  const sleep = (ms: number): Promise<{ cancelled: boolean }> =>
    new Promise<{ cancelled: boolean }>((resolve) => {
      const timer = setTimeout(() => resolve({ cancelled: false }), ms);
      cancelFn = () => {
        clearTimeout(timer);
        resolve({ cancelled: true });
      };
    });

  const cancel = () => {
    cancelFn?.();
    cancelFn = undefined;
  };

  return { sleep, cancel };
}

export async function runWorkerLoop(
  config: WorkerConfig,
  hopperHome: string,
  gatewayDeps: { git: GitGateway; claude: ClaudeGateway; fs: FsGateway; shell: ShellGateway },
  loopDeps: WorkerLoopDeps,
): Promise<void> {
  const { agentName, pollInterval, runOnce, concurrency } = config;
  const { claimNext, processItem: doProcessItem, sleep, log, onSignal } = loopDeps;

  let running = true;
  const activeTasks = new Map<string, Promise<void>>();

  const shutdown = () => {
    const action = resolveShutdownAction(!running, activeTasks.size);
    if (action.type === "already-shutting-down") return;
    running = false;
    log(action.message);
  };

  onSignal("SIGINT", shutdown);
  onSignal("SIGTERM", shutdown);

  log(
    `Hopper worker starting (agent: ${agentName}, poll: ${pollInterval}s, concurrency: ${concurrency})`,
  );

  while (running) {
    const loopAction = resolveLoopAction(activeTasks.size, concurrency, running);

    if (loopAction.type === "wait-for-slot") {
      await Promise.race(activeTasks.values());
      for (const [id, p] of activeTasks) {
        const settled = await Promise.race([p.then(() => true), Promise.resolve(false)]);
        if (settled) activeTasks.delete(id);
      }
      continue;
    }

    if (loopAction.type === "claim") {
      if (loopAction.shouldLog) {
        log("\nChecking for work...");
      }

      let claimedAny = false;
      for (let i = 0; i < loopAction.freeSlots; i++) {
        const item = await claimNext(agentName);
        if (!item) break;
        claimedAny = true;
        const task = doProcessItem(item, agentName, hopperHome, gatewayDeps, concurrency)
          .catch((err) => {
            console.error(`Error processing item ${shortId(item.id)}: ${err}`);
          })
          .finally(() => activeTasks.delete(item.id));
        activeTasks.set(item.id, task);
      }

      const postAction = resolvePostClaimLoopAction(
        activeTasks.size,
        claimedAny,
        runOnce,
        pollInterval,
      );

      switch (postAction.type) {
        case "exit-no-work":
          log(postAction.message);
          return;
        case "sleep":
          log(postAction.message);
          await sleep(pollInterval * 1000);
          continue;
        case "wait-and-exit":
          if (activeTasks.size > 0) {
            await Promise.allSettled(activeTasks.values());
          }
          return;
        case "continue":
          break;
      }
    }
  }

  // Graceful shutdown: wait for active tasks with timeout
  if (activeTasks.size > 0) {
    const SHUTDOWN_TIMEOUT = 60_000;
    const timeout = new Promise<void>((resolve) =>
      setTimeout(() => {
        log("Warning: shutdown timeout reached (60s). Some tasks may not have finished.");
        resolve();
      }, SHUTDOWN_TIMEOUT),
    );
    await Promise.race([Promise.allSettled(activeTasks.values()), timeout]);
  }
}

export async function workerCommand(parsed: ParsedArgs, deps?: WorkerDeps): Promise<void> {
  const git = deps?.git ?? createGitGateway();
  const claude = deps?.claude ?? createClaudeGateway();
  const fs = deps?.fs ?? createFsGateway();
  const shell = deps?.shell ?? createShellGateway();

  const config = resolveWorkerConfig(parsed.flags);
  const hopperHome = join(homedir(), ".hopper");
  const { sleep, cancel } = createCancellableSleep();

  const loopDeps: WorkerLoopDeps = {
    claimNext: claimNextItem,
    processItem,
    sleep,
    log: (msg) => console.log(msg),
    onSignal: (signal, handler) =>
      process.on(signal, () => {
        cancel();
        handler();
      }),
  };

  await runWorkerLoop(config, hopperHome, { git, claude, fs, shell }, loopDeps);
}
