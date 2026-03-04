import { mkdir } from "fs/promises";
import { homedir } from "os";
import { join } from "path";
import type { ParsedArgs } from "../cli.ts";
import { claimNextItem, completeItem } from "../store.ts";

async function gitWorktreeAdd(repoDir: string, worktreePath: string, branch: string): Promise<void> {
  const check = Bun.spawn(
    ["git", "show-ref", "--verify", "--quiet", `refs/heads/${branch}`],
    { cwd: repoDir, stdout: "pipe", stderr: "pipe" }
  );
  const exists = (await check.exited) === 0;

  const args = exists
    ? ["worktree", "add", worktreePath, branch]
    : ["worktree", "add", "-b", branch, worktreePath];

  const proc = Bun.spawn(["git", ...args], { cwd: repoDir, stdout: "pipe", stderr: "pipe" });
  if ((await proc.exited) !== 0) {
    throw new Error(`git worktree add failed for branch "${branch}"`);
  }
}

async function gitWorktreeRemove(repoDir: string, worktreePath: string): Promise<void> {
  const proc = Bun.spawn(
    ["git", "worktree", "remove", worktreePath, "--force"],
    { cwd: repoDir, stdout: "pipe", stderr: "pipe" }
  );
  await proc.exited; // best-effort; don't throw
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

    try {
      if (item.workingDir && item.branch) {
        worktreePath = join(homedir(), ".hopper", "worktrees", item.id);
        await mkdir(join(homedir(), ".hopper", "worktrees"), { recursive: true });
        console.log(`Setting up worktree at ${worktreePath}...`);
        await gitWorktreeAdd(item.workingDir, worktreePath, item.branch);
        workDir = worktreePath;
      } else if (item.workingDir) {
        workDir = item.workingDir;
      }

      const prompt = `You have been assigned the following task:\n\nTitle: ${item.title}\nDescription: ${item.description}\n\nPlease complete this task. When you are finished, provide a summary of what you did.`;

      console.log(`\nStarting Claude session...\nAudit log: ${auditFile}`);

      const proc = Bun.spawn(
        ["claude", "--print", "--verbose", "--dangerously-skip-permissions", "--output-format", "stream-json", prompt],
        { cwd: workDir ?? process.cwd(), stdout: "pipe", stderr: "pipe" }
      );

      const output = await new Response(proc.stdout).text();
      const stderrOutput = await new Response(proc.stderr).text();
      await Bun.write(auditFile, output + stderrOutput);
      const claudeExit = await proc.exited;

      const resultText = extractResult(output);
      await Bun.write(resultFile, resultText);
      console.log("\n--- Claude Output ---");
      console.log(resultText);
      console.log("---------------------");

      if (claudeExit === 0) {
        console.log("\nClaude session completed. Marking work item as complete...");
        await completeItem(item.claimToken!, agentName, resultText);
        console.log(`Completed: ${item.title}`);
      } else {
        console.log(`\nClaude session failed for item: ${item.title} (${item.id})`);
        console.log(`Manual intervention required — use 'hopper requeue ${item.id} --reason "..."' to retry.`);
      }
    } finally {
      if (worktreePath && item.workingDir) {
        console.log(`Removing worktree ${worktreePath} (branch ${item.branch} preserved)...`);
        await gitWorktreeRemove(item.workingDir, worktreePath);
      }
    }

    if (runOnce) return;
  }
}
