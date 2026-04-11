import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createGitGateway } from "./git-gateway.ts";

async function initRepo(dir: string): Promise<void> {
  const run = (args: string[]) =>
    Bun.spawn(args, { cwd: dir, stdout: "ignore", stderr: "ignore" }).exited;

  await run(["git", "init", "-b", "main"]);
  await run(["git", "config", "user.email", "test@example.com"]);
  await run(["git", "config", "user.name", "Test"]);
  // Create an initial commit so HEAD and branches are valid
  await writeFile(join(dir, "README.md"), "init");
  await run(["git", "add", "."]);
  await run(["git", "commit", "-m", "init"]);
}

describe("GitGateway", () => {
  const gateway = createGitGateway();
  let tempDir: string;

  afterEach(async () => {
    if (tempDir) {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  async function setup(): Promise<string> {
    tempDir = await mkdtemp(join(tmpdir(), "git-gw-"));
    await initRepo(tempDir);
    return tempDir;
  }

  test("getCurrentBranch returns the current branch name", async () => {
    const repoDir = await setup();
    const branch = await gateway.getCurrentBranch(repoDir);
    expect(branch).toBe("main");
  });

  test("branchExists returns true for an existing branch", async () => {
    const repoDir = await setup();
    const exists = await gateway.branchExists(repoDir, "main");
    expect(exists).toBe(true);
  });

  test("branchExists returns false for a non-existent branch", async () => {
    const repoDir = await setup();
    const exists = await gateway.branchExists(repoDir, "no-such-branch");
    expect(exists).toBe(false);
  });

  test("createBranch creates a branch that then passes branchExists", async () => {
    const repoDir = await setup();
    await gateway.createBranch(repoDir, "feature-x");
    const exists = await gateway.branchExists(repoDir, "feature-x");
    expect(exists).toBe(true);
  });

  test("createBranch with a duplicate name throws", async () => {
    const repoDir = await setup();
    await gateway.createBranch(repoDir, "dup-branch");
    await expect(gateway.createBranch(repoDir, "dup-branch")).rejects.toThrow();
  });

  test("isWorktreeDirty returns false on a clean repo", async () => {
    const repoDir = await setup();
    const dirty = await gateway.isWorktreeDirty(repoDir);
    expect(dirty).toBe(false);
  });

  test("isWorktreeDirty returns true after writing an untracked file", async () => {
    const repoDir = await setup();
    await writeFile(join(repoDir, "untracked.txt"), "new content");
    const dirty = await gateway.isWorktreeDirty(repoDir);
    expect(dirty).toBe(true);
  });

  test("commitAll commits all changes and repo is clean afterward", async () => {
    const repoDir = await setup();
    await writeFile(join(repoDir, "new-file.txt"), "some content");
    await gateway.commitAll(repoDir, "add new file");
    const dirty = await gateway.isWorktreeDirty(repoDir);
    expect(dirty).toBe(false);
  });

  test("createWorktree creates a worktree and worktreeRemove cleans it up", async () => {
    const repoDir = await setup();
    const worktreePath = join(repoDir, "..", "test-worktree");
    await gateway.createWorktree(repoDir, worktreePath, "work-branch", "main");

    // The worktree directory should exist and be on the work branch
    const branch = await gateway.getCurrentBranch(worktreePath);
    expect(branch).toBe("work-branch");

    // Clean up
    await gateway.worktreeRemove(repoDir, worktreePath);
  });
});
