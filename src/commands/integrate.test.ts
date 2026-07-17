import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { buildEngineeringBranchName } from "../git-workflow.ts";
import { addItem, saveItems } from "../store.ts";
import { makeItem, makeMockGit, makeParsed, setupTempStoreDir } from "../test-helpers.ts";
import type { IntegrateDryRunResult, IntegrateResult } from "./integrate.ts";
import { integrateCommand } from "./integrate.ts";

describe("integrateCommand", () => {
  const storeDir = setupTempStoreDir("hopper-integrate-test-");

  beforeEach(storeDir.beforeEach);
  afterEach(storeDir.afterEach);

  test("returns error when no id is provided", async () => {
    const result = await integrateCommand(makeParsed("integrate", []));
    expect(result.status).toBe("error");
    if (result.status === "error") {
      expect(result.message).toBe("Usage: hopper integrate <item-id>");
    }
  });

  test("returns error for unknown id", async () => {
    const item = makeItem({ status: "completed", workingDir: "/repo", branch: "hopper/abc" });
    await addItem(item);

    const result = await integrateCommand(makeParsed("integrate", ["nonexistent"]), makeMockGit());
    expect(result.status).toBe("error");
    if (result.status === "error") {
      expect(result.message).toContain("No item found with id");
    }
  });

  test("returns error for ambiguous id prefix", async () => {
    const item1 = makeItem({
      id: "aaaaaaaa-0000-0000-0000-000000000001",
      status: "completed",
      workingDir: "/repo",
      branch: "hopper/abc",
    });
    const item2 = makeItem({
      id: "aaaaaaaa-0000-0000-0000-000000000002",
      status: "completed",
      workingDir: "/repo",
      branch: "hopper/def",
    });
    await saveItems([item1, item2]);

    const result = await integrateCommand(makeParsed("integrate", ["aaaaaaaa"]), makeMockGit());
    expect(result.status).toBe("error");
    if (result.status === "error") {
      expect(result.message).toContain("Ambiguous id prefix");
    }
  });

  test("returns error when item status is queued", async () => {
    const item = makeItem({ status: "queued", workingDir: "/repo", branch: "hopper/abc" });
    await addItem(item);

    const result = await integrateCommand(makeParsed("integrate", [item.id]), makeMockGit());
    expect(result.status).toBe("error");
    if (result.status === "error") {
      expect(result.message).toContain("Cannot integrate item with status 'queued'");
    }
  });

  test("returns error when item has no workingDir or branch", async () => {
    const item = makeItem({ status: "completed" });
    await addItem(item);

    const result = await integrateCommand(makeParsed("integrate", [item.id]), makeMockGit());
    expect(result.status).toBe("error");
    if (result.status === "error") {
      expect(result.message).toContain("no workingDir/branch");
    }
  });

  test("happy path: integrates completed item using full uuid", async () => {
    const workingDir = "/repo";
    const branch = "hopper/feature";
    const item = makeItem({ status: "completed", workingDir, branch });
    await addItem(item);

    const git = makeMockGit();
    const result = await integrateCommand(makeParsed("integrate", [item.id], { apply: true }), git);

    expect(result.status).toBe("success");
    if (result.status === "success") {
      expect(git.checkout).toHaveBeenCalledWith(workingDir, "main");
      expect(git.mergeNoEdit).toHaveBeenCalledWith(workingDir, branch);
      expect(git.deleteBranch).toHaveBeenCalledWith(workingDir, branch);
      const data = result.data as IntegrateResult;
      expect(data.itemId).toBe(item.id);
      // Success message names the branch, the target, and the before/after HEADs.
      expect(result.humanOutput).toContain(`merged ${branch} into main of ${workingDir}`);
      expect(result.humanOutput).toContain(
        `(${data.oldHead.slice(0, 8)} → ${data.newHead.slice(0, 8)})`,
      );
      expect(data.oldHead).not.toBe(data.newHead);
    }
  });

  test("happy path: resolves item by 8-char id prefix", async () => {
    const workingDir = "/repo";
    const branch = "hopper/prefix-test";
    const item = makeItem({ status: "completed", workingDir, branch });
    await addItem(item);

    const git = makeMockGit();
    const result = await integrateCommand(
      makeParsed("integrate", [item.id.slice(0, 8)], { apply: true }),
      git,
    );

    expect(result.status).toBe("success");
    if (result.status === "success") {
      expect(git.checkout).toHaveBeenCalledWith(workingDir, "main");
      expect(git.mergeNoEdit).toHaveBeenCalledWith(workingDir, branch);
    }
  });

  test("--keep-worktree skips branch and worktree cleanup", async () => {
    const workingDir = "/repo";
    const branch = "hopper/keep-test";
    const item = makeItem({ status: "completed", workingDir, branch });
    await addItem(item);

    const git = makeMockGit();
    const result = await integrateCommand(
      makeParsed("integrate", [item.id], { "keep-worktree": true, apply: true }),
      git,
    );

    expect(result.status).toBe("success");
    expect(git.deleteBranch).not.toHaveBeenCalled();
    expect(git.worktreeRemove).not.toHaveBeenCalled();
  });

  test("previews by default (no --apply) without executing git", async () => {
    const workingDir = "/repo";
    const branch = "hopper/preview-test";
    const item = makeItem({ status: "completed", workingDir, branch });
    await addItem(item);

    const git = makeMockGit();
    const result = await integrateCommand(makeParsed("integrate", [item.id]), git);

    expect(result.status).toBe("success");
    if (result.status === "success") {
      const data = result.data as IntegrateDryRunResult;
      expect(data.dryRun).toBe(true);
      expect(data.targetBranch).toBe("main");
      expect(data.commands).toBeArray();
      expect(data.commands.length).toBeGreaterThan(0);
      expect(result.humanOutput).toMatch(/^Preview/);
      // The preview must tell the user how to actually execute.
      expect(result.humanOutput).toContain("--apply");
    }
    // Safe by default: no git command runs without --apply.
    expect(git.checkout).not.toHaveBeenCalled();
    expect(git.mergeNoEdit).not.toHaveBeenCalled();
  });

  test("--dry-run is still accepted as a no-op preview (back-compat)", async () => {
    const item = makeItem({ status: "completed", workingDir: "/repo", branch: "hopper/dry" });
    await addItem(item);

    const git = makeMockGit();
    const result = await integrateCommand(
      makeParsed("integrate", [item.id], { "dry-run": true }),
      git,
    );

    expect(result.status).toBe("success");
    if (result.status === "success") {
      expect((result.data as IntegrateDryRunResult).dryRun).toBe(true);
    }
    expect(git.checkout).not.toHaveBeenCalled();
    expect(git.mergeNoEdit).not.toHaveBeenCalled();
  });

  test("returns error when merge fails and does not clean up", async () => {
    const workingDir = "/repo";
    const branch = "hopper/conflict";
    const item = makeItem({ status: "completed", workingDir, branch });
    await addItem(item);

    const git = makeMockGit({
      mergeNoEdit: mock(async () => ({
        exitCode: 1,
        stderr: "CONFLICT (content): Merge conflict in src/foo.ts",
      })),
    });
    const result = await integrateCommand(makeParsed("integrate", [item.id], { apply: true }), git);

    expect(result.status).toBe("error");
    if (result.status === "error") {
      expect(result.message).toContain("CONFLICT (content)");
    }
    expect(git.deleteBranch).not.toHaveBeenCalled();
    expect(git.worktreeRemove).not.toHaveBeenCalled();
  });

  test("in_progress item with existing worktree directory proceeds", async () => {
    const workingDir = "/repo";
    const branch = "hopper/eng-task";
    const item = makeItem({ status: "in_progress", workingDir, branch });
    await addItem(item);

    const git = makeMockGit();
    const result = await integrateCommand(
      makeParsed("integrate", [item.id], { apply: true }),
      git,
      async () => "directory",
    );

    expect(result.status).toBe("success");
    if (result.status === "success") {
      expect(git.checkout).toHaveBeenCalledWith(workingDir, "main");
      expect(git.mergeNoEdit).toHaveBeenCalledWith(workingDir, branch);
    }
  });

  test("in_progress item with missing worktree directory returns worktree-specific error", async () => {
    const item = makeItem({
      status: "in_progress",
      workingDir: "/repo",
      branch: "hopper/eng-task",
    });
    await addItem(item);

    const result = await integrateCommand(
      makeParsed("integrate", [item.id]),
      makeMockGit(),
      async () => "missing",
    );

    expect(result.status).toBe("error");
    if (result.status === "error") {
      expect(result.message).toContain("worktree");
      expect(result.message).toContain("does not exist");
      expect(result.message).not.toContain(
        "Only 'completed', 'in_progress', or 'failed' items can be integrated",
      );
    }
  });

  test("in_progress item with file at worktree path returns not-a-directory error", async () => {
    const item = makeItem({
      status: "in_progress",
      workingDir: "/repo",
      branch: "hopper/eng-task",
    });
    await addItem(item);

    const result = await integrateCommand(
      makeParsed("integrate", [item.id]),
      makeMockGit(),
      async () => "file",
    );

    expect(result.status).toBe("error");
    if (result.status === "error") {
      expect(result.message).toContain("not a directory");
      expect(result.message).not.toContain(
        "Only 'completed', 'in_progress', or 'failed' items can be integrated",
      );
    }
  });

  test("cancelled item is rejected by status guard with status-based error message", async () => {
    const item = makeItem({ status: "cancelled", workingDir: "/repo", branch: "hopper/abc" });
    await addItem(item);

    const result = await integrateCommand(makeParsed("integrate", [item.id]), makeMockGit());

    expect(result.status).toBe("error");
    if (result.status === "error") {
      expect(result.message).toContain("Cannot integrate item with status 'cancelled'");
      expect(result.message).toContain(
        "Only 'completed', 'in_progress', or 'failed' items can be integrated",
      );
    }
  });

  test("surfaces git stderr and skips cleanup when merge refuses on a dirty tree", async () => {
    const workingDir = "/repo";
    const branch = "hopper/dirty-tree";
    const item = makeItem({ status: "completed", workingDir, branch });
    await addItem(item);

    const stderr =
      "error: Your local changes to the following files would be overwritten by merge:\n\tCargo.lock\nPlease commit your changes or stash them before you merge.\nAborting";
    const git = makeMockGit({
      mergeNoEdit: mock(async () => ({ exitCode: 1, stderr })),
    });
    const result = await integrateCommand(makeParsed("integrate", [item.id], { apply: true }), git);

    expect(result.status).toBe("error");
    if (result.status === "error") {
      expect(result.message).toContain("would be overwritten by merge");
      expect(result.message).toContain("Cargo.lock");
      expect(result.message).toContain(branch);
    }
    // A refused merge must not delete the branch or remove the worktree.
    expect(git.deleteBranch).not.toHaveBeenCalled();
    expect(git.worktreeRemove).not.toHaveBeenCalled();
  });

  test("engineering item merges the surviving work branch, not target-into-target", async () => {
    const workingDir = "/repo";
    // Engineering items store the TARGET branch in `branch`; the real work
    // lives on hopper-eng/<slug>-<prefix>.
    const item = makeItem({
      status: "completed",
      workingDir,
      branch: "main",
      type: "engineering",
      engineeringBranchSlug: "fix-integrate-noop",
    });
    await addItem(item);
    const workBranch = buildEngineeringBranchName(item.id, "fix-integrate-noop");

    const git = makeMockGit();
    const result = await integrateCommand(makeParsed("integrate", [item.id], { apply: true }), git);

    expect(result.status).toBe("success");
    if (result.status === "success") {
      expect(git.checkout).toHaveBeenCalledWith(workingDir, "main");
      // Must merge the hopper-eng work branch, NOT main into main.
      expect(git.mergeNoEdit).toHaveBeenCalledWith(workingDir, workBranch);
      expect(git.mergeNoEdit).not.toHaveBeenCalledWith(workingDir, "main");
      expect(git.deleteBranch).toHaveBeenCalledWith(workingDir, workBranch);
      const data = result.data as IntegrateResult;
      expect(data.branch).toBe(workBranch);
      expect(data.targetBranch).toBe("main");
      expect(result.humanOutput).toContain(`merged ${workBranch} into main`);
    }
  });

  test("engineering item without a slug still merges the derived work branch", async () => {
    const workingDir = "/repo";
    const item = makeItem({
      status: "completed",
      workingDir,
      branch: "main",
      type: "engineering",
    });
    await addItem(item);
    const workBranch = buildEngineeringBranchName(item.id, null);

    const git = makeMockGit();
    const result = await integrateCommand(makeParsed("integrate", [item.id], { apply: true }), git);

    expect(result.status).toBe("success");
    expect(git.mergeNoEdit).toHaveBeenCalledWith(workingDir, workBranch);
  });

  test("no-op merge (HEAD unchanged) reports error and performs no cleanup", async () => {
    const workingDir = "/repo";
    const branch = "hopper/already-merged";
    const item = makeItem({ status: "completed", workingDir, branch });
    await addItem(item);

    // HEAD is identical before and after the merge — nothing was integrated.
    const git = makeMockGit({
      revParse: mock(async () => "cafebabecafebabecafebabecafebabecafebabe"),
    });
    const result = await integrateCommand(makeParsed("integrate", [item.id], { apply: true }), git);

    expect(result.status).toBe("error");
    if (result.status === "error") {
      expect(result.message).toContain("no-op");
      expect(result.message).toContain("cafebabe");
    }
    expect(git.deleteBranch).not.toHaveBeenCalled();
    expect(git.worktreeRemove).not.toHaveBeenCalled();
  });

  test("success data records old and new HEAD SHAs", async () => {
    const workingDir = "/repo";
    const branch = "hopper/head-sha";
    const item = makeItem({ status: "completed", workingDir, branch });
    await addItem(item);

    const oldHead = "1111111111111111111111111111111111111111";
    const newHead = "2222222222222222222222222222222222222222";
    let call = 0;
    const git = makeMockGit({
      revParse: mock(async (): Promise<string> => (call++ === 0 ? oldHead : newHead)),
    });
    const result = await integrateCommand(makeParsed("integrate", [item.id], { apply: true }), git);

    expect(result.status).toBe("success");
    if (result.status === "success") {
      const data = result.data as IntegrateResult;
      expect(data.oldHead).toBe(oldHead);
      expect(data.newHead).toBe(newHead);
      expect(result.humanOutput).toContain("(11111111 → 22222222)");
    }
  });

  test("returns success with warning when deleteBranch throws", async () => {
    const workingDir = "/repo";
    const branch = "hopper/branch-fail";
    const item = makeItem({ status: "completed", workingDir, branch });
    await addItem(item);

    const git = makeMockGit({
      deleteBranch: mock(async () => {
        throw new Error("branch not fully merged");
      }),
    });
    const result = await integrateCommand(makeParsed("integrate", [item.id], { apply: true }), git);

    expect(result.status).toBe("success");
    if (result.status === "success") {
      expect(result.warnings).toBeDefined();
      expect(result.warnings?.some((w) => w.includes("branch not fully merged"))).toBe(true);
    }
  });
});
