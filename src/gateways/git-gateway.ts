export type MergeOutcome =
  | { type: "fast-forward" | "merge-commit"; success: true; message: string }
  | { type: "conflict" | "skipped"; success: false; message: string };

export interface GitGateway {
  worktreeAdd(
    repoDir: string,
    worktreePath: string,
    targetBranch: string,
    itemId: string,
  ): Promise<string>;
  worktreeRemove(repoDir: string, worktreePath: string): Promise<void>;
  isWorktreeDirty(worktreePath: string): Promise<boolean>;
  commitAll(worktreePath: string, message: string): Promise<void>;
  mergeWorkBranch(repoDir: string, targetBranch: string, workBranch: string): Promise<MergeOutcome>;
  push(repoDir: string, branch: string): Promise<{ success: boolean; message: string }>;
}

async function worktreeAdd(
  repoDir: string,
  worktreePath: string,
  targetBranch: string,
  itemId: string,
): Promise<string> {
  const workBranch = `hopper/${itemId.slice(0, 8)}`;

  // Ensure targetBranch exists locally before creating the worktree
  const checkProc = Bun.spawn(["git", "rev-parse", "--verify", targetBranch], {
    cwd: repoDir,
    stdout: "ignore",
    stderr: "ignore",
  });
  if ((await checkProc.exited) !== 0) {
    // Try to create a tracking branch from origin
    const remoteRef = `origin/${targetBranch}`;
    const remoteCheck = Bun.spawn(["git", "rev-parse", "--verify", remoteRef], {
      cwd: repoDir,
      stdout: "ignore",
      stderr: "ignore",
    });
    if ((await remoteCheck.exited) === 0) {
      const createProc = Bun.spawn(["git", "branch", "--track", targetBranch, remoteRef], {
        cwd: repoDir,
        stdout: "ignore",
        stderr: "pipe",
      });
      const createStderr = await new Response(createProc.stderr).text();
      if ((await createProc.exited) !== 0) {
        throw new Error(
          `Failed to create tracking branch "${targetBranch}" from ${remoteRef}: ${createStderr.trim()}`,
        );
      }
      console.log(`Created tracking branch "${targetBranch}" from ${remoteRef}.`);
    } else {
      // Branch doesn't exist locally or remotely — create from HEAD
      const createProc = Bun.spawn(["git", "branch", targetBranch], {
        cwd: repoDir,
        stdout: "ignore",
        stderr: "pipe",
      });
      const createStderr = await new Response(createProc.stderr).text();
      if ((await createProc.exited) !== 0) {
        throw new Error(
          `Failed to create branch "${targetBranch}" from HEAD: ${createStderr.trim()}`,
        );
      }
      console.log(`Branch "${targetBranch}" not found locally or remotely; created from HEAD.`);
    }
  }

  const proc = Bun.spawn(["git", "worktree", "add", "-b", workBranch, worktreePath, targetBranch], {
    cwd: repoDir,
    stdout: "ignore",
    stderr: "pipe",
  });
  const stderr = await new Response(proc.stderr).text();
  if ((await proc.exited) !== 0) {
    throw new Error(`git worktree add failed: ${stderr.trim()}`);
  }
  return workBranch;
}

async function worktreeRemove(repoDir: string, worktreePath: string): Promise<void> {
  const proc = Bun.spawn(["git", "worktree", "remove", worktreePath, "--force"], {
    cwd: repoDir,
    stdout: "ignore",
    stderr: "ignore",
  });
  await proc.exited; // best-effort
}

async function isWorktreeDirty(worktreePath: string): Promise<boolean> {
  const proc = Bun.spawn(["git", "status", "--porcelain"], {
    cwd: worktreePath,
    stdout: "pipe",
    stderr: "ignore",
  });
  const output = await new Response(proc.stdout).text();
  await proc.exited;
  return output.trim().length > 0;
}

async function commitAll(worktreePath: string, message: string): Promise<void> {
  const addProc = Bun.spawn(["git", "add", "-A"], {
    cwd: worktreePath,
    stdout: "ignore",
    stderr: "pipe",
  });
  const addStderr = await new Response(addProc.stderr).text();
  if ((await addProc.exited) !== 0) {
    throw new Error(`git add -A failed: ${addStderr.trim()}`);
  }

  const commitProc = Bun.spawn(["git", "commit", "-m", message], {
    cwd: worktreePath,
    stdout: "ignore",
    stderr: "pipe",
  });
  const commitStderr = await new Response(commitProc.stderr).text();
  if ((await commitProc.exited) !== 0) {
    throw new Error(`git commit failed: ${commitStderr.trim()}`);
  }
}

async function mergeWorkBranch(
  repoDir: string,
  targetBranch: string,
  workBranch: string,
): Promise<MergeOutcome> {
  // Confirm the target branch is currently checked out
  const headProc = Bun.spawn(["git", "rev-parse", "--abbrev-ref", "HEAD"], {
    cwd: repoDir,
    stdout: "pipe",
    stderr: "ignore",
  });
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
  const ffProc = Bun.spawn(["git", "merge", "--ff-only", workBranch], {
    cwd: repoDir,
    stdout: "ignore",
    stderr: "ignore",
  });
  if ((await ffProc.exited) === 0) {
    await Bun.spawn(["git", "branch", "-d", workBranch], {
      cwd: repoDir,
      stdout: "ignore",
      stderr: "ignore",
    }).exited;
    return {
      type: "fast-forward",
      success: true,
      message: `Fast-forward merged ${workBranch} → ${targetBranch}; work branch deleted.`,
    };
  }

  // Fall back to merge commit
  const mergeProc = Bun.spawn(["git", "merge", "--no-edit", workBranch], {
    cwd: repoDir,
    stdout: "ignore",
    stderr: "ignore",
  });
  if ((await mergeProc.exited) === 0) {
    await Bun.spawn(["git", "branch", "-d", workBranch], {
      cwd: repoDir,
      stdout: "ignore",
      stderr: "ignore",
    }).exited;
    return {
      type: "merge-commit",
      success: true,
      message: `Merged ${workBranch} → ${targetBranch} (merge commit); work branch deleted.`,
    };
  }

  // Conflicts — abort and preserve the work branch
  await Bun.spawn(["git", "merge", "--abort"], { cwd: repoDir, stdout: "ignore", stderr: "ignore" })
    .exited;
  return {
    type: "conflict",
    success: false,
    message: `Merge conflict: ${workBranch} → ${targetBranch} failed. Branch preserved for manual resolution.`,
  };
}

async function push(
  repoDir: string,
  branch: string,
): Promise<{ success: boolean; message: string }> {
  const proc = Bun.spawn(["git", "push", "origin", branch], {
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

export function createGitGateway(): GitGateway {
  return { worktreeAdd, worktreeRemove, isWorktreeDirty, commitAll, mergeWorkBranch, push };
}
