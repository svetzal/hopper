import { beforeEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createWorkerShimGateway } from "./worker-shim-gateway.ts";

async function makeTempDir(): Promise<string> {
  const base = join(
    tmpdir(),
    `hopper-shim-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  );
  await mkdir(base, { recursive: true });
  return base;
}

describe("WorkerShimGateway", () => {
  let shimDir: string;
  const gateway = createWorkerShimGateway();

  beforeEach(async () => {
    shimDir = await makeTempDir();
  });

  test("creates shim files for all entries in denyMap on empty dir", async () => {
    const denyMap = new Map<string, ReadonlyArray<string> | "all">([
      ["git", ["commit", "push"]],
      ["curl", "all"],
    ]);

    const result = await gateway.synchronize(shimDir, denyMap);

    expect(result.status).toBe("synchronized");
    const gitContent = await readFile(join(shimDir, "git"), "utf8");
    const curlContent = await readFile(join(shimDir, "curl"), "utf8");

    expect(gitContent).toContain("#!/bin/sh");
    expect(gitContent).toContain("commit)");
    expect(curlContent).toContain("exit 1");
  });

  test("returns skipped-windows on win32 platform without creating files", async () => {
    const win32Gateway = createWorkerShimGateway("win32");
    const denyMap = new Map<string, ReadonlyArray<string> | "all">([["git", ["commit"]]]);

    const result = await win32Gateway.synchronize(shimDir, denyMap);

    expect(result.status).toBe("skipped-windows");
    const gitExists = await Bun.file(join(shimDir, "git")).exists();
    expect(gitExists).toBe(false);
  });

  test("sets executable bit on created shims", async () => {
    const denyMap = new Map<string, ReadonlyArray<string> | "all">([["git", ["commit"]]]);

    await gateway.synchronize(shimDir, denyMap);

    const s = await stat(join(shimDir, "git"));
    expect(s.mode & 0o111).not.toBe(0);
  });

  test("idempotent: rerunning does not change mtime when content is unchanged", async () => {
    const denyMap = new Map<string, ReadonlyArray<string> | "all">([["curl", "all"]]);

    await gateway.synchronize(shimDir, denyMap);
    const mtimeBefore = (await stat(join(shimDir, "curl"))).mtimeMs;

    // Small delay to detect any mtime change
    await new Promise((resolve) => setTimeout(resolve, 50));
    await gateway.synchronize(shimDir, denyMap);
    const mtimeAfter = (await stat(join(shimDir, "curl"))).mtimeMs;

    expect(mtimeAfter).toBe(mtimeBefore);
  });

  test("rewrites file when on-disk content has drifted", async () => {
    const denyMap = new Map<string, ReadonlyArray<string> | "all">([["curl", "all"]]);

    // Pre-write stale content
    await writeFile(join(shimDir, "curl"), "stale content", "utf8");

    await gateway.synchronize(shimDir, denyMap);

    const content = await readFile(join(shimDir, "curl"), "utf8");
    expect(content).toContain("#!/bin/sh");
    expect(content).not.toContain("stale content");
  });

  test("deletes shims present on disk but absent from denyMap", async () => {
    // Write a shim manually that is not in the new denyMap
    await writeFile(join(shimDir, "wget"), "#!/bin/sh\nexit 1\n", "utf8");

    const denyMap = new Map<string, ReadonlyArray<string> | "all">([["curl", "all"]]);

    await gateway.synchronize(shimDir, denyMap);

    const wgetExists = await Bun.file(join(shimDir, "wget")).exists();
    expect(wgetExists).toBe(false);

    const curlExists = await Bun.file(join(shimDir, "curl")).exists();
    expect(curlExists).toBe(true);
  });

  test("sets executable bit even when content matches (idempotent chmod)", async () => {
    const denyMap = new Map<string, ReadonlyArray<string> | "all">([["git", ["commit"]]]);

    // Write correct content but wrong permissions
    await gateway.synchronize(shimDir, denyMap);
    await chmod(join(shimDir, "git"), 0o644);

    await gateway.synchronize(shimDir, denyMap);

    const s = await stat(join(shimDir, "git"));
    expect(s.mode & 0o111).not.toBe(0);
  });
});

// Subprocess smoke tests — POSIX only (shims use /bin/sh)
const describeOnPosix = process.platform === "win32" ? describe.skip : describe;

describeOnPosix("WorkerShimGateway subprocess smoke tests", () => {
  let shimDir: string;
  const gateway = createWorkerShimGateway();

  beforeEach(async () => {
    shimDir = await makeTempDir();
  });

  test("git shim blocks 'git commit' even when chained behind innocuous command", async () => {
    const denyMap = new Map<string, ReadonlyArray<string> | "all">([
      [
        "git",
        [
          "commit",
          "push",
          "merge",
          "rebase",
          "reset",
          "checkout",
          "switch",
          "branch",
          "tag",
          "stash",
          "cherry-pick",
          "clean",
          "reflog",
          "worktree",
        ],
      ],
    ]);
    await gateway.synchronize(shimDir, denyMap);

    const proc = Bun.spawn(["/bin/sh", "-c", "cd /tmp && git commit --allow-empty -m smoke"], {
      env: {
        PATH: shimDir,
        HOPPER_REAL_PATH: process.env.PATH ?? "",
        HOME: process.env.HOME ?? "/tmp",
      },
      stdout: "pipe",
      stderr: "pipe",
    });

    const [stderr, exitCode] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);

    expect(exitCode).not.toBe(0);
    expect(stderr).toContain("hopper-worker-shim");
    expect(stderr).toContain("denied in investigation sessions");
  });

  test("git shim allows read-only 'git log' with correct HOPPER_REAL_PATH", async () => {
    const gitBin = Bun.which("git");
    if (!gitBin) {
      // git not available in this environment — skip gracefully
      return;
    }

    const denyMap = new Map<string, ReadonlyArray<string> | "all">([["git", ["commit", "push"]]]);
    await gateway.synchronize(shimDir, denyMap);

    // Create a real temp git repo to run log against
    const repoDir = await makeTempDir();
    const initProc = Bun.spawn(["git", "init", repoDir], {
      stdout: "pipe",
      stderr: "pipe",
    });
    await initProc.exited;

    const commitProc = Bun.spawn(["git", "-C", repoDir, "commit", "--allow-empty", "-m", "init"], {
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: "Test",
        GIT_AUTHOR_EMAIL: "test@test.com",
        GIT_COMMITTER_NAME: "Test",
        GIT_COMMITTER_EMAIL: "test@test.com",
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    await commitProc.exited;

    const logProc = Bun.spawn(["/bin/sh", "-c", `git -C ${repoDir} log --oneline -1`], {
      env: {
        PATH: `${shimDir}:${process.env.PATH ?? ""}`,
        HOPPER_REAL_PATH: process.env.PATH ?? "",
        HOME: process.env.HOME ?? "/tmp",
        GIT_AUTHOR_NAME: "Test",
        GIT_AUTHOR_EMAIL: "test@test.com",
        GIT_COMMITTER_NAME: "Test",
        GIT_COMMITTER_EMAIL: "test@test.com",
      },
      stdout: "pipe",
      stderr: "pipe",
    });

    const exitCode = await logProc.exited;
    expect(exitCode).toBe(0);
  });
});
