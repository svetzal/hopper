import { join } from "node:path";
import {
  buildEngineeringTranscript,
  resolveEngineeringPreconditions,
} from "../engineering-workflow.ts";
import { toErrorMessage } from "../error-utils.ts";
import type { AgentRunner } from "../gateways/agent-runner.ts";
import type { FsGateway } from "../gateways/fs-gateway.ts";
import type { GitGateway } from "../gateways/git-gateway.ts";
import { buildEngineeringBranchName } from "../git-workflow.ts";
import type { Profile } from "../profile.ts";
import type { ClaimedItem } from "../store.ts";
import { setItemEngineeringBranchSlug } from "../store.ts";
import {
  buildPlanOptions,
  buildPlanPrompt,
  resolveBranchSlugSource,
} from "../task-type-workflow.ts";
import {
  type EngineeringAuditPaths,
  resolveAuditPaths,
  resolveEngineeringAuditPaths,
} from "../worker-workflow.ts";
import {
  type ExecuteValidateContext,
  runExecuteValidateLoop,
  runPhase,
} from "./worker-engineering-loop.ts";
import {
  resolveEngineeringBranchSlug,
  resolveEngineeringCommitMessage,
  resolveValidateOutcomeWithFallback,
} from "./worker-engineering-text.ts";
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

// Orchestration and phase-step functions take a single typed context object;
// thin leaf helpers (e.g. commitWorktreeChanges, executeWork) take positional args.

export type { ExecuteValidateContext };
export { resolveValidateOutcomeWithFallback, runExecuteValidateLoop };

export interface EngineeringContext {
  item: ClaimedItem;
  agentName: string;
  worktreePath: string;
  hopperHome: string;
  paths: EngineeringAuditPaths;
  deps: { git: GitGateway; claude: AgentRunner; fs: FsGateway; profile: Profile };
  log: LogFn;
}

async function safePersistBranchSlug(itemId: string, slug: string, log: LogFn): Promise<void> {
  return safeVoid(() => setItemEngineeringBranchSlug(itemId, slug), "Slug persistence failed", log);
}

export async function runPlanPhase(ctx: EngineeringContext): Promise<{ planText: string } | null> {
  const { item, worktreePath, paths, deps, log } = ctx;
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

export async function runEngineeringPreconditions(
  ctx: EngineeringContext,
): Promise<{ ok: true; workingDir: string; branch: string } | { ok: false }> {
  const { item, agentName, hopperHome, deps, log } = ctx;
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
  return { ok: true, workingDir: preconditions.workingDir, branch: preconditions.branch };
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
    slug = await resolveEngineeringBranchSlug(claude, profile, item, log);
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
    const reason =
      e instanceof StaleEngineeringBranchError
        ? `Stale branch: ${e.message}`
        : `Worktree setup failed: ${toErrorMessage(e)}`;
    log(`Pre-spawn failure — auto-requeueing: ${reason}`);
    await safeRequeue(item.id, reason, agentName, log);
    return { ok: false };
  }
}

export async function processEngineeringItem(
  item: ClaimedItem,
  agentName: string,
  hopperHome: string,
  deps: { git: GitGateway; claude: AgentRunner; fs: FsGateway; profile: Profile },
  concurrency: number = 1,
): Promise<void> {
  const log = createLogger(item.id, concurrency);
  const paths = resolveEngineeringAuditPaths(item.id, hopperHome);
  const worktreePath = join(hopperHome, "worktrees", item.id);
  const ctx: EngineeringContext = { item, agentName, worktreePath, hopperHome, paths, deps, log };

  const preconditions = await runEngineeringPreconditions(ctx);
  if (!preconditions.ok) return;
  const { workingDir, branch } = preconditions;

  logClaimBanner(item, log, [
    `Dir:     ${workingDir}`,
    `Branch:  ${branch}`,
    `Type:    engineering${item.agent ? ` (agent: ${item.agent})` : ""}`,
  ]);

  const workBranch = await resolveWorkBranch(ctx);

  const worktreeSetup = await setupEngineeringWorktree(ctx, { workingDir, branch, workBranch });
  if (!worktreeSetup.ok) return;

  const planResult = await runPlanPhase(ctx);
  if (!planResult) return;
  const { planText } = planResult;

  const loopResult = await runExecuteValidateLoop({
    item,
    worktreePath,
    planText,
    paths,
    hopperHome,
    deps: { claude: deps.claude, fs: deps.fs, profile: deps.profile },
    log,
  });
  if (!loopResult.passed) return;

  const { dirty } = await commitEngineeringChanges(ctx);

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
    deps: { git: deps.git, fs: deps.fs },
    log,
  });
}
