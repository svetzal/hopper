import { homedir } from "os";
import { join } from "path";
import type { ParsedArgs } from "../cli.ts";
import { claimNextItem, completeItem } from "../store.ts";
import type { ClaudeGateway } from "../gateways/claude-gateway.ts";
import { createClaudeGateway } from "../gateways/claude-gateway.ts";
import type { FsGateway } from "../gateways/fs-gateway.ts";
import { createFsGateway } from "../gateways/fs-gateway.ts";
import type { GitGateway } from "../gateways/git-gateway.ts";
import { createGitGateway } from "../gateways/git-gateway.ts";
import {
  buildAutoCommitPrompt,
  buildTaskPrompt,
  resolveAuditPaths,
  resolveCompletionAction,
  resolveMergeAction,
  resolvePostClaudeAction,
  resolveWorkSetup,
} from "../worker-workflow.ts";

export interface WorkerDeps {
  git?: GitGateway;
  claude?: ClaudeGateway;
  fs?: FsGateway;
}

export async function workerCommand(
  parsed: ParsedArgs,
  deps?: WorkerDeps,
): Promise<void> {
  const git = deps?.git ?? createGitGateway();
  const claude = deps?.claude ?? createClaudeGateway();
  const fs = deps?.fs ?? createFsGateway();

  const agentName =
    typeof parsed.flags.agent === "string" ? parsed.flags.agent : "claude-worker";
  const pollInterval =
    typeof parsed.flags.interval === "string"
      ? parseInt(parsed.flags.interval, 10)
      : 60;
  const runOnce = parsed.flags.once === true;

  const hopperHome = join(homedir(), ".hopper");

  let running = true;
  process.on("SIGINT", () => {
    console.log("\nShutting down.");
    running = false;
  });
  process.on("SIGTERM", () => {
    running = false;
  });

  console.log(`Hopper worker starting (agent: ${agentName}, poll: ${pollInterval}s)`);

  while (running) {
    console.log("\nChecking for work...");
    const item = await claimNextItem(agentName);

    if (!item) {
      if (runOnce) {
        console.log("No work available.");
        return;
      }
      console.log(`No work available. Waiting ${pollInterval}s...`);
      await new Promise((r) => setTimeout(r, pollInterval * 1000));
      continue;
    }

    console.log(`Claimed: ${item.title}`);
    console.log(`Token:   ${item.claimToken}`);
    console.log(`ID:      ${item.id}`);
    if (item.workingDir) console.log(`Dir:     ${item.workingDir}`);
    if (item.branch) console.log(`Branch:  ${item.branch}`);

    const { auditDir, auditFile, resultFile } = resolveAuditPaths(
      item.id,
      hopperHome,
    );
    await fs.ensureDir(auditDir);

    const workSetup = resolveWorkSetup(item, hopperHome);

    let worktreePath: string | undefined;
    let workBranch: string | undefined;
    let workDir: string | undefined;

    try {
      if (workSetup.type === "worktree") {
        worktreePath = workSetup.worktreePath;
        await fs.ensureDir(join(hopperHome, "worktrees"));
        console.log(`Setting up worktree at ${worktreePath}...`);
        workBranch = await git.worktreeAdd(
          workSetup.repoDir,
          worktreePath,
          workSetup.branch,
          item.id,
        );
        console.log(`Work branch: ${workBranch}`);
        workDir = worktreePath;
      } else if (workSetup.type === "existing-dir") {
        workDir = workSetup.dir;
      }

      const prompt = buildTaskPrompt(item);
      console.log(`\nStarting Claude session...\nAudit log: ${auditFile}`);
      const { exitCode: claudeExit, result: claudeResult } = await claude.runSession(
        prompt,
        workDir ?? process.cwd(),
        auditFile,
      );

      // Auto-commit any changes Claude left uncommitted in the worktree
      if (worktreePath) {
        const dirty = await git.isWorktreeDirty(worktreePath);
        const { shouldAutoCommit } = resolvePostClaudeAction(true, dirty);
        if (shouldAutoCommit) {
          console.log("\nUncommitted changes found. Running auto-commit session...");
          await claude.runSession(
            buildAutoCommitPrompt(item),
            worktreePath,
            auditFile,
            { append: true },
          );
          if (await git.isWorktreeDirty(worktreePath)) {
            console.log("Warning: changes still uncommitted after auto-commit attempt.");
          } else {
            console.log("Auto-commit successful.");
          }
        }
      }

      // Remove worktree (branch is preserved for merge step)
      if (worktreePath && item.workingDir) {
        console.log("Removing worktree...");
        await git.worktreeRemove(item.workingDir, worktreePath);
        worktreePath = undefined;
      }

      // Merge work branch back to target (only on clean Claude exit)
      let mergeNote = "";
      const { shouldMerge } = resolveMergeAction(claudeExit, workBranch, item);
      if (shouldMerge && workBranch && item.workingDir && item.branch) {
        console.log(`Merging ${workBranch} → ${item.branch}...`);
        const mergeResult = await git.mergeWorkBranch(
          item.workingDir,
          item.branch,
          workBranch,
        );
        console.log(mergeResult.message);
        mergeNote = `\n\n---\nMerge: ${mergeResult.message}`;
        if (!mergeResult.success) {
          console.log(`Action required: manually merge branch ${workBranch}.`);
        }
      }

      const { action, result: finalResult } = resolveCompletionAction(
        claudeExit,
        claudeResult,
        mergeNote,
      );
      await fs.writeFile(resultFile, finalResult);

      console.log("\n--- Claude Output ---");
      console.log(claudeResult);
      if (mergeNote) console.log(mergeNote.trim());
      console.log("---------------------");

      if (action === "complete") {
        console.log("\nMarking item complete...");
        const { completed, recurred } = await completeItem(item.claimToken!, agentName, finalResult);
        console.log(`Completed: ${completed.title}`);
        if (recurred) {
          console.log(`Re-queued: ${completed.title} (next run: ${new Date(recurred.scheduledAt!).toLocaleString()})`);
        }
      } else {
        console.log(`\nClaude session failed for: ${item.title} (${item.id})`);
        if (workBranch) console.log(`Work branch ${workBranch} preserved for review.`);
        console.log(`Use 'hopper requeue ${item.id} --reason "..."' to retry.`);
      }
    } finally {
      // Belt-and-suspenders: clean up worktree if something threw mid-flight
      if (worktreePath && item.workingDir) {
        await git.worktreeRemove(item.workingDir, worktreePath);
      }
    }

    if (runOnce) return;
  }
}
