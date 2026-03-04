import { mkdir } from "fs/promises";
import { homedir } from "os";
import { join } from "path";
import type { ParsedArgs } from "../cli.ts";
import { claimNextItem, completeItem } from "../store.ts";

async function gitWorktreeAdd(repoDir: string, worktreePath: string, targetBranch: string, itemId: string): Promise<string> {
  const workBranch = `hopper/${itemId.slice(0, 8)}`;
  const proc = Bun.spawn(
    ["git", "worktree", "add", "-b", workBranch, worktreePath, targetBranch],
    { cwd: repoDir, stdout: "ignore", stderr: "pipe" }
  );
  const stderr = await new Response(proc.stderr).text();
  if ((await proc.exited) !== 0) {
    throw new Error(`git worktree add failed: ${stderr.trim()}`);
  }
  return workBranch;
}

async function gitWorktreeRemove(repoDir: string, worktreePath: string): Promise<void> {
  const proc = Bun.spawn(
    ["git", "worktree", "remove", worktreePath, "--force"],
    { cwd: repoDir, stdout: "ignore", stderr: "ignore" }
  );
  await proc.exited; // best-effort
}

async function isWorktreeDirty(worktreePath: string): Promise<boolean> {
  const proc = Bun.spawn(
    ["git", "status", "--porcelain"],
    { cwd: worktreePath, stdout: "pipe", stderr: "ignore" }
  );
  const output = await new Response(proc.stdout).text();
  await proc.exited;
  return output.trim().length > 0;
}

type MergeOutcome =
  | { type: "fast-forward" | "merge-commit"; success: true; message: string }
  | { type: "conflict" | "skipped"; success: false; message: string };

async function gitMergeWorkBranch(repoDir: string, targetBranch: string, workBranch: string): Promise<MergeOutcome> {
  // Confirm the target branch is currently checked out
  const headProc = Bun.spawn(
    ["git", "rev-parse", "--abbrev-ref", "HEAD"],
    { cwd: repoDir, stdout: "pipe", stderr: "ignore" }
  );
  const currentBranch = (await new Response(headProc.stdout).text()).trim();
  await headProc.exited;

  if (currentBranch !== targetBranch) {
    return {
      type: "skipped",
      success: false,
      message: `Target branch "${targetBranch}" is not checked out (HEAD is "${currentBranch}"). Branch ${workBranch} preserved for manual merge.`,
    };
  }

  // Try fast-forward first
  const ffProc = Bun.spawn(
    ["git", "merge", "--ff-only", workBranch],
    { cwd: repoDir, stdout: "ignore", stderr: "ignore" }
  );
  if ((await ffProc.exited) === 0) {
    await Bun.spawn(["git", "branch", "-d", workBranch], { cwd: repoDir, stdout: "ignore", stderr: "ignore" }).exited;
    return { type: "fast-forward", success: true, message: `Fast-forward merged ${workBranch} → ${targetBranch}; work branch deleted.` };
  }

  // Fall back to merge commit
  const mergeProc = Bun.spawn(
    ["git", "merge", "--no-edit", workBranch],
    { cwd: repoDir, stdout: "ignore", stderr: "ignore" }
  );
  if ((await mergeProc.exited) === 0) {
    await Bun.spawn(["git", "branch", "-d", workBranch], { cwd: repoDir, stdout: "ignore", stderr: "ignore" }).exited;
    return { type: "merge-commit", success: true, message: `Merged ${workBranch} → ${targetBranch} (merge commit); work branch deleted.` };
  }

  // Conflicts — abort and preserve the work branch
  await Bun.spawn(["git", "merge", "--abort"], { cwd: repoDir, stdout: "ignore", stderr: "ignore" }).exited;
  return {
    type: "conflict",
    success: false,
    message: `Merge conflict: ${workBranch} → ${targetBranch} failed. Branch preserved for manual resolution.`,
  };
}

function extractResult(jsonlOutput: string): string {
  for (const line of jsonlOutput.split("\n")) {
    try {
      const obj = JSON.parse(line);
      if (obj.type === "result" && typeof obj.result === "string") return obj.result;
    } catch {
      // skip non-JSON lines
    }
  }
  return "(see audit log for details)";
}

async function spawnClaude(
  prompt: string,
  cwd: string,
  auditFile: string,
  { append = false }: { append?: boolean } = {}
): Promise<{ exitCode: number; result: string }> {
  const proc = Bun.spawn(
    ["claude", "--print", "--verbose", "--dangerously-skip-permissions", "--output-format", "stream-json", prompt],
    { cwd, stdout: "pipe", stderr: "pipe" }
  );
  // Read concurrently to avoid pipe buffer deadlock
  const [output, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const exitCode = await proc.exited;

  if (append) {
    const existing = await Bun.file(auditFile).text().catch(() => "");
    const separator = JSON.stringify({ type: "session-separator", label: "auto-commit session" }) + "\n";
    await Bun.write(auditFile, existing + separator + output + stderr);
  } else {
    await Bun.write(auditFile, output + stderr);
  }

  return { exitCode, result: extractResult(output) };
}

export async function workerCommand(parsed: ParsedArgs): Promise<void> {
  const agentName = typeof parsed.flags.agent === "string" ? parsed.flags.agent : "claude-worker";
  const pollInterval = typeof parsed.flags.interval === "string" ? parseInt(parsed.flags.interval, 10) : 60;
  const runOnce = parsed.flags.once === true;

  let running = true;
  process.on("SIGINT", () => { console.log("\nShutting down."); running = false; });
  process.on("SIGTERM", () => { running = false; });

  console.log(`Hopper worker starting (agent: ${agentName}, poll: ${pollInterval}s)`);

  while (running) {
    console.log("\nChecking for work...");
    const item = await claimNextItem(agentName);

    if (!item) {
      if (runOnce) { console.log("No work available."); return; }
      console.log(`No work available. Waiting ${pollInterval}s...`);
      await new Promise(r => setTimeout(r, pollInterval * 1000));
      continue;
    }

    console.log(`Claimed: ${item.title}`);
    console.log(`Token:   ${item.claimToken}`);
    console.log(`ID:      ${item.id}`);
    if (item.workingDir) console.log(`Dir:     ${item.workingDir}`);
    if (item.branch)     console.log(`Branch:  ${item.branch}`);

    const auditDir = join(homedir(), ".hopper", "audit");
    await mkdir(auditDir, { recursive: true });
    const auditFile = join(auditDir, `${item.id}-audit.jsonl`);
    const resultFile = join(auditDir, `${item.id}-result.md`);

    let workDir: string | undefined;
    let worktreePath: string | undefined;
    let workBranch: string | undefined;

    try {
      if (item.workingDir && item.branch) {
        worktreePath = join(homedir(), ".hopper", "worktrees", item.id);
        await mkdir(join(homedir(), ".hopper", "worktrees"), { recursive: true });
        console.log(`Setting up worktree at ${worktreePath}...`);
        workBranch = await gitWorktreeAdd(item.workingDir, worktreePath, item.branch, item.id);
        console.log(`Work branch: ${workBranch}`);
        workDir = worktreePath;
      } else if (item.workingDir) {
        workDir = item.workingDir;
      }

      const prompt = `You have been assigned the following task:\n\nTitle: ${item.title}\nDescription: ${item.description}\n\nPlease complete this task. When you are finished, commit your changes with a descriptive commit message and provide a summary of what you did.`;

      console.log(`\nStarting Claude session...\nAudit log: ${auditFile}`);
      const { exitCode: claudeExit, result: claudeResult } = await spawnClaude(prompt, workDir ?? process.cwd(), auditFile);

      // Auto-commit any changes Claude left uncommitted
      if (worktreePath && await isWorktreeDirty(worktreePath)) {
        console.log("\nUncommitted changes found. Running auto-commit session...");
        const commitPrompt = `A work session just completed on the following task but left uncommitted changes:\n\nTitle: ${item.title}\n\nPlease:\n1. Review the outstanding changes with \`git diff\` and \`git status\`\n2. Stage all changes with \`git add -A\`\n3. Commit with a descriptive message summarising what was done\n\nDo not make any other changes — only commit what is already there.`;
        await spawnClaude(commitPrompt, worktreePath, auditFile, { append: true });

        if (await isWorktreeDirty(worktreePath)) {
          console.log("Warning: changes still uncommitted after auto-commit attempt.");
        } else {
          console.log("Auto-commit successful.");
        }
      }

      // Remove worktree (branch is preserved)
      if (worktreePath && item.workingDir) {
        console.log("Removing worktree...");
        await gitWorktreeRemove(item.workingDir, worktreePath);
        worktreePath = undefined;
      }

      // Merge work branch back to target (only on clean Claude exit)
      let mergeNote = "";
      if (claudeExit === 0 && workBranch && item.workingDir && item.branch) {
        console.log(`Merging ${workBranch} → ${item.branch}...`);
        const mergeResult = await gitMergeWorkBranch(item.workingDir, item.branch, workBranch);
        console.log(mergeResult.message);
        mergeNote = `\n\n---\nMerge: ${mergeResult.message}`;
        if (!mergeResult.success) {
          console.log(`Action required: manually merge branch ${workBranch}.`);
        }
      }

      const finalResult = claudeResult + mergeNote;
      await Bun.write(resultFile, finalResult);

      console.log("\n--- Claude Output ---");
      console.log(claudeResult);
      if (mergeNote) console.log(mergeNote.trim());
      console.log("---------------------");

      if (claudeExit === 0) {
        console.log("\nMarking item complete...");
        await completeItem(item.claimToken!, agentName, finalResult);
        console.log(`Completed: ${item.title}`);
      } else {
        console.log(`\nClaude session failed for: ${item.title} (${item.id})`);
        if (workBranch) console.log(`Work branch ${workBranch} preserved for review.`);
        console.log(`Use 'hopper requeue ${item.id} --reason "..."' to retry.`);
      }
    } finally {
      // Belt-and-suspenders: clean up worktree if something threw mid-flight
      if (worktreePath && item.workingDir) {
        await gitWorktreeRemove(item.workingDir, worktreePath);
      }
    }

    if (runOnce) return;
  }
}
