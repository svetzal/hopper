export type MergeOutcome =
  | { type: "fast-forward" | "merge-commit"; success: true; message: string }
  | { type: "conflict" | "skipped"; success: false; message: string };

/**
 * Resolve the full path to the git executable.
 *
 * Compiled Bun binaries may fail to locate bare command names via posix_spawn,
 * so we resolve the path explicitly using Bun.which() before every spawn call.
 */
function resolveGit(): string {
  const resolved = Bun.which("git");
  if (!resolved) {
    throw new Error("git executable not found on PATH. Ensure git is installed and available.");
  }
  return resolved;
}

async function spawnGit(
  args: string[],
  cwd: string,
  pipes: { stdout?: boolean; stderr?: boolean } = {},
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn([resolveGit(), ...args], {
    cwd,
    stdout: pipes.stdout ? "pipe" : "ignore",
    stderr: pipes.stderr ? "pipe" : "ignore",
  });
  const stdoutText = pipes.stdout ? new Response(proc.stdout!).text() : Promise.resolve("");
  const stderrText = pipes.stderr ? new Response(proc.stderr!).text() : Promise.resolve("");
  const [exitCode, stdout, stderr] = await Promise.all([proc.exited, stdoutText, stderrText]);
  return { exitCode, stdout, stderr };
}

export interface GitGateway {
  branchExists(repoDir: string, branch: string): Promise<boolean>;
  remoteBranchExists(repoDir: string, branch: string): Promise<boolean>;
  createTrackingBranch(repoDir: string, branch: string, remoteRef: string): Promise<void>;
  createBranch(repoDir: string, branch: string): Promise<void>;
  createWorktree(
    repoDir: string,
    worktreePath: string,
    workBranch: string,
    baseBranch: string,
  ): Promise<void>;
  worktreeRemove(repoDir: string, worktreePath: string): Promise<void>;
  isWorktreeDirty(worktreePath: string): Promise<boolean>;
  commitAll(worktreePath: string, message: string): Promise<void>;
  getCurrentBranch(repoDir: string): Promise<string>;
  checkout(repoDir: string, branch: string): Promise<void>;
  mergeFastForward(repoDir: string, branch: string): Promise<number>;
  mergeCommit(repoDir: string, branch: string): Promise<number>;
  mergeAbort(repoDir: string): Promise<void>;
  mergeNoEdit(repoDir: string, branch: string): Promise<{ exitCode: number; stderr: string }>;
  deleteBranch(repoDir: string, branch: string): Promise<void>;
  push(repoDir: string, branch: string): Promise<{ success: boolean; message: string }>;
  pushTags(repoDir: string): Promise<{ success: boolean; message: string }>;
  /**
   * Return a compact description of the changes in the worktree, suitable for
   * feeding to a small LLM for commit-message generation. Combines `git diff
   * --stat HEAD` (for the file list) with `git diff HEAD` truncated to a
   * reasonable length (so we don't blow the Haiku context window on a large
   * refactor).
   */
  diffSummary(worktreePath: string): Promise<string>;
}

async function branchExists(repoDir: string, branch: string): Promise<boolean> {
  const { exitCode } = await spawnGit(["rev-parse", "--verify", branch], repoDir);
  return exitCode === 0;
}

async function remoteBranchExists(repoDir: string, branch: string): Promise<boolean> {
  const { exitCode } = await spawnGit(
    ["ls-remote", "--exit-code", "--heads", "origin", branch],
    repoDir,
  );
  return exitCode === 0;
}

async function createTrackingBranch(
  repoDir: string,
  branch: string,
  remoteRef: string,
): Promise<void> {
  const { exitCode, stderr } = await spawnGit(["branch", "--track", branch, remoteRef], repoDir, {
    stderr: true,
  });
  if (exitCode !== 0) {
    throw new Error(
      `Failed to create tracking branch "${branch}" from ${remoteRef}: ${stderr.trim()}`,
    );
  }
}

async function createBranch(repoDir: string, branch: string): Promise<void> {
  const { exitCode, stderr } = await spawnGit(["branch", branch], repoDir, { stderr: true });
  if (exitCode !== 0) {
    throw new Error(`Failed to create branch "${branch}" from HEAD: ${stderr.trim()}`);
  }
}

async function createWorktree(
  repoDir: string,
  worktreePath: string,
  workBranch: string,
  baseBranch: string,
): Promise<void> {
  const { exitCode, stderr } = await spawnGit(
    ["worktree", "add", "-b", workBranch, worktreePath, baseBranch],
    repoDir,
    { stderr: true },
  );
  if (exitCode !== 0) {
    throw new Error(`git worktree add failed: ${stderr.trim()}`);
  }
}

async function worktreeRemove(repoDir: string, worktreePath: string): Promise<void> {
  await spawnGit(["worktree", "remove", worktreePath, "--force"], repoDir);
}

async function isWorktreeDirty(worktreePath: string): Promise<boolean> {
  const { stdout } = await spawnGit(["status", "--porcelain"], worktreePath, { stdout: true });
  return stdout.trim().length > 0;
}

async function commitAll(worktreePath: string, message: string): Promise<void> {
  const addResult = await spawnGit(["add", "-A"], worktreePath, { stderr: true });
  if (addResult.exitCode !== 0) {
    throw new Error(`git add -A failed: ${addResult.stderr.trim()}`);
  }

  const commitResult = await spawnGit(["commit", "-m", message], worktreePath, { stderr: true });
  if (commitResult.exitCode !== 0) {
    throw new Error(`git commit failed: ${commitResult.stderr.trim()}`);
  }
}

async function getCurrentBranch(repoDir: string): Promise<string> {
  const { stdout } = await spawnGit(["rev-parse", "--abbrev-ref", "HEAD"], repoDir, {
    stdout: true,
  });
  return stdout.trim();
}

async function checkout(repoDir: string, branch: string): Promise<void> {
  const { exitCode, stderr } = await spawnGit(["checkout", branch], repoDir, { stderr: true });
  if (exitCode !== 0) {
    throw new Error(`git checkout "${branch}" failed: ${stderr.trim()}`);
  }
}

async function mergeFastForward(repoDir: string, branch: string): Promise<number> {
  const { exitCode } = await spawnGit(["merge", "--ff-only", branch], repoDir);
  return exitCode;
}

async function mergeCommit(repoDir: string, branch: string): Promise<number> {
  const { exitCode } = await spawnGit(["merge", "--no-ff", branch], repoDir);
  return exitCode;
}

async function mergeAbort(repoDir: string): Promise<void> {
  await spawnGit(["merge", "--abort"], repoDir);
}

async function mergeNoEdit(
  repoDir: string,
  branch: string,
): Promise<{ exitCode: number; stderr: string }> {
  const { exitCode, stderr } = await spawnGit(["merge", branch, "--no-edit"], repoDir, {
    stderr: true,
  });
  return { exitCode, stderr };
}

async function deleteBranch(repoDir: string, branch: string): Promise<void> {
  await spawnGit(["branch", "-d", branch], repoDir);
}

async function push(
  repoDir: string,
  branch: string,
): Promise<{ success: boolean; message: string }> {
  const { exitCode, stderr } = await spawnGit(["push", "origin", branch], repoDir, {
    stderr: true,
  });
  if (exitCode !== 0) {
    return { success: false, message: `Push failed: ${stderr.trim()}` };
  }
  return { success: true, message: `Pushed ${branch} to origin.` };
}

async function diffSummary(worktreePath: string): Promise<string> {
  const { stdout: stat } = await spawnGit(["diff", "--stat", "HEAD"], worktreePath, {
    stdout: true,
  });

  // Keep the body diff small; Haiku does not need 10k lines to write a subject
  // + body. 200 lines is plenty for a conventional commit.
  const { stdout: body } = await spawnGit(["diff", "HEAD"], worktreePath, { stdout: true });
  const truncated = body.split("\n").slice(0, 200).join("\n");
  const suffix = body.split("\n").length > 200 ? "\n... (truncated)" : "";

  return `${stat.trim()}\n\n${truncated}${suffix}`.trim();
}

async function pushTags(repoDir: string): Promise<{ success: boolean; message: string }> {
  const { exitCode, stderr } = await spawnGit(["push", "origin", "--tags"], repoDir, {
    stderr: true,
  });
  if (exitCode !== 0) {
    return { success: false, message: `Tag push failed: ${stderr.trim()}` };
  }
  return { success: true, message: "Pushed tags to origin." };
}

export function createGitGateway(): GitGateway {
  return {
    branchExists,
    remoteBranchExists,
    createTrackingBranch,
    createBranch,
    createWorktree,
    worktreeRemove,
    isWorktreeDirty,
    commitAll,
    getCurrentBranch,
    checkout,
    mergeFastForward,
    mergeCommit,
    mergeAbort,
    mergeNoEdit,
    deleteBranch,
    push,
    pushTags,
    diffSummary,
  };
}
