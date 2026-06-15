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
  resolveCompletionLabels,
  resolveCompletionPlan,
  resolveExecutionPlan,
  resolveMergeAction,
  resolvePostClaudeAction,
  resolveWorkSetup,
  type WorkSetup,
} from "../worker-workflow.ts";
import { processEngineeringItem } from "./worker-engineering.ts";
import {
  createLogger,
  finalizeCompletion,
  type LogFn,
  logClaimBanner,
  mergeAndPush,
  orchestrateWorktreeSetup,
  safeRequeue,
  teardownWorktree,
} from "./worker-orchestration.ts";

export interface WorkerDeps {
  git?: GitGateway;
  claude?: AgentRunner;
  fs?: FsGateway;
  shell?: ShellGateway;
  profiles?: ProfilesGateway;
  workerShim?: WorkerShimGateway;
  log?: (msg: string) => void;
  claimNext?: (agentName: string) => Promise<import("../store.ts").ClaimedItem | null | undefined>;
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
  const plan = resolveCompletionPlan(exitCode, result, mergeNote);

  const { outputLabel, sessionLabel } = resolveCompletionLabels(item);
  log(`--- ${outputLabel} Output ---`);
  log(result);
  if (mergeNote) log(mergeNote.trim());
  log("---------------------");

  switch (plan.kind) {
    case "complete":
      await finalizeCompletion({
        fs,
        resultFile,
        finalResult: plan.finalResult,
        claimToken: item.claimToken,
        agentName,
        log,
      });
      break;
    case "auto-requeue":
      await fs.writeFile(resultFile, plan.finalResult);
      log(`${sessionLabel} failed for: ${item.title} (${item.id})`);
      if (workBranch) log(`Work branch ${workBranch} preserved for review.`);
      log(`Auto-requeueing: ${item.title} (${plan.reason}).`);
      await safeRequeue(item.id, plan.reason, agentName, log);
      break;
    case "manual-requeue":
      await fs.writeFile(resultFile, plan.finalResult);
      log(`${sessionLabel} failed for: ${item.title} (${item.id})`);
      if (workBranch) log(`Work branch ${workBranch} preserved for review.`);
      log(`Use 'hopper requeue ${item.id} --reason "..."' to retry.`);
      break;
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

    const mergeAction = resolveMergeAction(exitCode, workBranch, item);
    const mergeNote = mergeAction.shouldMerge
      ? await mergeAndPush(git, item, mergeAction.workBranch, log)
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
