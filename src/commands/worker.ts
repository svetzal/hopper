import { join } from "node:path";
import type { AgentRunner } from "../gateways/agent-runner.ts";
import type { FsGateway } from "../gateways/fs-gateway.ts";
import type { GitGateway } from "../gateways/git-gateway.ts";
import type { ProfilesGateway } from "../gateways/profiles-gateway.ts";
import type { ShellGateway } from "../gateways/shell-gateway.ts";
import type { WorkerShimGateway } from "../gateways/worker-shim-gateway.ts";
import type { Profile } from "../profile.ts";
import type { ClaimedItem, Item } from "../store.ts";
import {
  buildCommitMessage,
  resolveAuditPaths,
  resolveAutoRequeue,
  resolveCompletionAction,
  resolveCompletionLabels,
  resolveExecutionPlan,
  resolveMergeAction,
  resolvePostClaudeAction,
  resolveWorkSetup,
  type WorkSetup,
} from "../worker-workflow.ts";
import { processEngineeringItem } from "./worker-engineering.ts";
import {
  createLogger,
  type LogFn,
  logClaimBanner,
  logCompleteOutcome,
  mergeAndPush,
  orchestrateWorktreeSetup,
  safeRequeue,
  teardownWorktree,
} from "./worker-shared.ts";

export interface WorkerDeps {
  git?: GitGateway;
  claude?: AgentRunner;
  fs?: FsGateway;
  shell?: ShellGateway;
  profiles?: ProfilesGateway;
  workerShim?: WorkerShimGateway;
}

interface CompletionContext {
  item: ClaimedItem;
  agentName: string;
  exitCode: number;
  result: string;
  mergeNote: string;
  workBranch: string | undefined;
  fs: FsGateway;
  resultFile: string;
  log: LogFn;
}

async function handleCompletion(ctx: CompletionContext): Promise<void> {
  const { item, agentName, exitCode, result, mergeNote, workBranch, fs, resultFile, log } = ctx;
  const { action, result: finalResult } = resolveCompletionAction(exitCode, result, mergeNote);
  await fs.writeFile(resultFile, finalResult);

  const { outputLabel, sessionLabel } = resolveCompletionLabels(item);
  log(`--- ${outputLabel} Output ---`);
  log(result);
  if (mergeNote) log(mergeNote.trim());
  log("---------------------");

  if (action === "complete") {
    await logCompleteOutcome(item.claimToken, agentName, finalResult, log);
  } else {
    log(`${sessionLabel} failed for: ${item.title} (${item.id})`);
    if (workBranch) log(`Work branch ${workBranch} preserved for review.`);

    // A non-zero exit with no captured result almost always means Claude
    // never ran (argv / environment / startup error). Auto-requeue those so
    // the queue heals without operator intervention. Items that produced any
    // real result stay wedged at in_progress on purpose — there's probably
    // something worth reading before the operator decides whether to retry.
    const autoRequeue = resolveAutoRequeue(exitCode, result);
    if (autoRequeue.shouldAutoRequeue) {
      log(`Auto-requeueing: ${item.title} (${autoRequeue.reason}).`);
      await safeRequeue(item.id, autoRequeue.reason, agentName, log);
    } else {
      log(`Use 'hopper requeue ${item.id} --reason "..."' to retry.`);
    }
  }
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

async function setupGenericWorktree(
  workSetup: WorkSetup,
  hopperHome: string,
  itemId: string,
  deps: { git: GitGateway; fs: FsGateway },
  log: LogFn,
): Promise<{
  worktreePath: string | undefined;
  workBranch: string | undefined;
  workDir: string | undefined;
}> {
  const { git, fs } = deps;
  let worktreePath: string | undefined;
  let workBranch: string | undefined;
  let workDir: string | undefined;

  if (workSetup.type === "worktree") {
    worktreePath = workSetup.worktreePath;
    await fs.ensureDir(join(hopperHome, "worktrees"));
    log(`Setting up worktree at ${worktreePath}...`);
    workBranch = await orchestrateWorktreeSetup({
      git,
      repoDir: workSetup.repoDir,
      branch: workSetup.branch,
      worktreePath,
      itemId,
    });
    log(`Work branch: ${workBranch}`);
    workDir = worktreePath;
  } else if (workSetup.type === "existing-dir") {
    workDir = workSetup.dir;
  }

  return { worktreePath, workBranch, workDir };
}

async function executeWork(
  item: Item,
  workDir: string | undefined,
  auditFile: string,
  hopperHome: string,
  deps: { claude: AgentRunner; shell: ShellGateway; profile: Profile },
  log: LogFn,
): Promise<{ exitCode: number; result: string }> {
  const { claude, shell, profile } = deps;
  const plan = resolveExecutionPlan(item, hopperHome, process.env.PATH ?? "");
  if (plan.type === "command") {
    log(`Starting command...\nAudit log: ${auditFile}`);
    return shell.runCommand(plan.command, workDir ?? process.cwd(), auditFile);
  }
  if (plan.type === "investigation") {
    log(`Starting investigation session (deep, read-only)...\nAudit log: ${auditFile}`);
    return claude.runSession(plan.prompt, workDir ?? process.cwd(), auditFile, {
      ...plan.options,
      profile,
    });
  }
  log(`Starting agent session...\nAudit log: ${auditFile}`);
  return claude.runSession(plan.prompt, workDir ?? process.cwd(), auditFile, {
    ...plan.options,
    profile,
  });
}

export async function processItem(
  item: ClaimedItem,
  agentName: string,
  hopperHome: string,
  deps: {
    git: GitGateway;
    claude: AgentRunner;
    fs: FsGateway;
    shell: ShellGateway;
    profiles: ProfilesGateway;
  },
  concurrency: number = 1,
): Promise<void> {
  const { git, claude, fs, shell, profiles } = deps;
  const log = createLogger(item.id, concurrency);

  // Resolve the per-item profile. Items added before the profile rollout have
  // no `item.profile`, so we fall back to defaultProfile from config.json.
  // A missing/broken profile is a hard error — we can't safely guess how to
  // dispatch the runner.
  const profileName = item.profile ?? (await profiles.loadConfig()).defaultProfile;
  const profileResult = await profiles.loadProfile(profileName);
  if (!profileResult.ok) {
    log(
      `Cannot start item ${item.id}: profile '${profileName}' could not be loaded — ${profileResult.error}`,
    );
    await safeRequeue(
      item.id,
      `profile '${profileName}' not loadable: ${profileResult.error}`,
      agentName,
      log,
    );
    return;
  }
  const profile = profileResult.profile;

  if (item.type === "engineering" && !item.command) {
    return processEngineeringItem(
      item,
      agentName,
      hopperHome,
      { git, claude, fs, profile },
      concurrency,
    );
  }

  const extras: string[] = [];
  if (item.workingDir) extras.push(`Dir:     ${item.workingDir}`);
  if (item.branch) extras.push(`Branch:  ${item.branch}`);
  if (item.command) extras.push(`Command: ${item.command}`);
  logClaimBanner(item, log, extras);

  const { auditDir, auditFile, resultFile } = resolveAuditPaths(item.id, hopperHome);
  await fs.ensureDir(auditDir);

  const workSetup = resolveWorkSetup(item, hopperHome);

  let worktreePath: string | undefined;
  let workBranch: string | undefined;
  let workDir: string | undefined;

  try {
    ({ worktreePath, workBranch, workDir } = await setupGenericWorktree(
      workSetup,
      hopperHome,
      item.id,
      { git, fs },
      log,
    ));

    const { exitCode, result } = await executeWork(
      item,
      workDir,
      auditFile,
      hopperHome,
      { claude, shell, profile },
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

    await handleCompletion({
      item,
      agentName,
      exitCode,
      result,
      mergeNote,
      workBranch,
      fs,
      resultFile,
      log,
    });
  } finally {
    // Belt-and-suspenders: clean up worktree if something threw mid-flight
    if (worktreePath && item.workingDir) {
      await git.worktreeRemove(item.workingDir, worktreePath);
    }
  }
}
