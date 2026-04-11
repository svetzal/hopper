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
  deleteBranch(repoDir: string, branch: string): Promise<void>;
  push(repoDir: string, branch: string): Promise<{ success: boolean; message: string }>;
  pushTags(repoDir: string): Promise<{ success: boolean; message: string }>;
}

async function branchExists(repoDir: string, branch: string): Promise<boolean> {
  const proc = Bun.spawn([resolveGit(), "rev-parse", "--verify", branch], {
    cwd: repoDir,
    stdout: "ignore",
    stderr: "ignore",
  });
  return (await proc.exited) === 0;
}

async function remoteBranchExists(repoDir: string, branch: string): Promise<boolean> {
  const proc = Bun.spawn([resolveGit(), "ls-remote", "--exit-code", "--heads", "origin", branch], {
    cwd: repoDir,
    stdout: "ignore",
    stderr: "ignore",
  });
  return (await proc.exited) === 0;
}

async function createTrackingBranch(
  repoDir: string,
  branch: string,
  remoteRef: string,
): Promise<void> {
  const proc = Bun.spawn([resolveGit(), "branch", "--track", branch, remoteRef], {
    cwd: repoDir,
    stdout: "ignore",
    stderr: "pipe",
  });
  const stderr = await new Response(proc.stderr).text();
  if ((await proc.exited) !== 0) {
    throw new Error(
      `Failed to create tracking branch "${branch}" from ${remoteRef}: ${stderr.trim()}`,
    );
  }
}

async function createBranch(repoDir: string, branch: string): Promise<void> {
  const proc = Bun.spawn([resolveGit(), "branch", branch], {
    cwd: repoDir,
    stdout: "ignore",
    stderr: "pipe",
  });
  const stderr = await new Response(proc.stderr).text();
  if ((await proc.exited) !== 0) {
    throw new Error(`Failed to create branch "${branch}" from HEAD: ${stderr.trim()}`);
  }
}

async function createWorktree(
  repoDir: string,
  worktreePath: string,
  workBranch: string,
  baseBranch: string,
): Promise<void> {
  const proc = Bun.spawn(
    [resolveGit(), "worktree", "add", "-b", workBranch, worktreePath, baseBranch],
    {
      cwd: repoDir,
      stdout: "ignore",
      stderr: "pipe",
    },
  );
  const stderr = await new Response(proc.stderr).text();
  if ((await proc.exited) !== 0) {
    throw new Error(`git worktree add failed: ${stderr.trim()}`);
  }
}

async function worktreeRemove(repoDir: string, worktreePath: string): Promise<void> {
  const proc = Bun.spawn([resolveGit(), "worktree", "remove", worktreePath, "--force"], {
    cwd: repoDir,
    stdout: "ignore",
    stderr: "ignore",
  });
  await proc.exited; // best-effort
}

async function isWorktreeDirty(worktreePath: string): Promise<boolean> {
  const proc = Bun.spawn([resolveGit(), "status", "--porcelain"], {
    cwd: worktreePath,
    stdout: "pipe",
    stderr: "ignore",
  });
  const output = await new Response(proc.stdout).text();
  await proc.exited;
  return output.trim().length > 0;
}

async function commitAll(worktreePath: string, message: string): Promise<void> {
  const addProc = Bun.spawn([resolveGit(), "add", "-A"], {
    cwd: worktreePath,
    stdout: "ignore",
    stderr: "pipe",
  });
  const addStderr = await new Response(addProc.stderr).text();
  if ((await addProc.exited) !== 0) {
    throw new Error(`git add -A failed: ${addStderr.trim()}`);
  }

  const commitProc = Bun.spawn([resolveGit(), "commit", "-m", message], {
    cwd: worktreePath,
    stdout: "ignore",
    stderr: "pipe",
  });
  const commitStderr = await new Response(commitProc.stderr).text();
  if ((await commitProc.exited) !== 0) {
    throw new Error(`git commit failed: ${commitStderr.trim()}`);
  }
}

async function getCurrentBranch(repoDir: string): Promise<string> {
  const proc = Bun.spawn([resolveGit(), "rev-parse", "--abbrev-ref", "HEAD"], {
    cwd: repoDir,
    stdout: "pipe",
    stderr: "ignore",
  });
  const stdout = await new Response(proc.stdout).text();
  await proc.exited;
  return stdout.trim();
}

async function checkout(repoDir: string, branch: string): Promise<void> {
  const proc = Bun.spawn([resolveGit(), "checkout", branch], {
    cwd: repoDir,
    stdout: "ignore",
    stderr: "pipe",
  });
  const stderr = await new Response(proc.stderr).text();
  if ((await proc.exited) !== 0) {
    throw new Error(`git checkout "${branch}" failed: ${stderr.trim()}`);
  }
}

async function mergeFastForward(repoDir: string, branch: string): Promise<number> {
  const proc = Bun.spawn([resolveGit(), "merge", "--ff-only", branch], {
    cwd: repoDir,
    stdout: "ignore",
    stderr: "ignore",
  });
  return proc.exited;
}

async function mergeCommit(repoDir: string, branch: string): Promise<number> {
  const proc = Bun.spawn([resolveGit(), "merge", "--no-ff", branch], {
    cwd: repoDir,
    stdout: "ignore",
    stderr: "ignore",
  });
  return proc.exited;
}

async function mergeAbort(repoDir: string): Promise<void> {
  const proc = Bun.spawn([resolveGit(), "merge", "--abort"], {
    cwd: repoDir,
    stdout: "ignore",
    stderr: "ignore",
  });
  await proc.exited;
}

async function deleteBranch(repoDir: string, branch: string): Promise<void> {
  const proc = Bun.spawn([resolveGit(), "branch", "-d", branch], {
    cwd: repoDir,
    stdout: "ignore",
    stderr: "ignore",
  });
  await proc.exited;
}

async function push(
  repoDir: string,
  branch: string,
): Promise<{ success: boolean; message: string }> {
  const proc = Bun.spawn([resolveGit(), "push", "origin", branch], {
    cwd: repoDir,
    stdout: "ignore",
    stderr: "pipe",
  });
  const stderr = await new Response(proc.stderr).text();
  if ((await proc.exited) !== 0) {
    return { success: false, message: `Push failed: ${stderr.trim()}` };
  }
  return { success: true, message: `Pushed ${branch} to origin.` };
}

async function pushTags(repoDir: string): Promise<{ success: boolean; message: string }> {
  const proc = Bun.spawn([resolveGit(), "push", "origin", "--tags"], {
    cwd: repoDir,
    stdout: "ignore",
    stderr: "pipe",
  });
  const stderr = await new Response(proc.stderr).text();
  if ((await proc.exited) !== 0) {
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
    deleteBranch,
    push,
    pushTags,
  };
}
