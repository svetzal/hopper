import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { addItem, saveItems } from "../store.ts";
import { makeItem, makeMockGit, makeParsed, setupTempStoreDir } from "../test-helpers.ts";
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
    const result = await integrateCommand(makeParsed("integrate", [item.id]), git);

    expect(result.status).toBe("success");
    if (result.status === "success") {
      expect(git.checkout).toHaveBeenCalledWith(workingDir, "main");
      expect(git.mergeNoEdit).toHaveBeenCalledWith(workingDir, branch);
      expect(git.deleteBranch).toHaveBeenCalledWith(workingDir, branch);
      expect(result.humanOutput).toBe(
        `Integrated ${item.id.slice(0, 8)} from ${branch} into main of ${workingDir}.`,
      );
      expect((result.data as { itemId: string }).itemId).toBe(item.id);
    }
  });

  test("happy path: resolves item by 8-char id prefix", async () => {
    const workingDir = "/repo";
    const branch = "hopper/prefix-test";
    const item = makeItem({ status: "completed", workingDir, branch });
    await addItem(item);

    const git = makeMockGit();
    const result = await integrateCommand(makeParsed("integrate", [item.id.slice(0, 8)]), git);

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
      makeParsed("integrate", [item.id], { "keep-worktree": true }),
      git,
    );

    expect(result.status).toBe("success");
    expect(git.deleteBranch).not.toHaveBeenCalled();
    expect(git.worktreeRemove).not.toHaveBeenCalled();
  });

  test("--dry-run returns commands without executing git", async () => {
    const workingDir = "/repo";
    const branch = "hopper/dry-test";
    const item = makeItem({ status: "completed", workingDir, branch });
    await addItem(item);

    const git = makeMockGit();
    const result = await integrateCommand(
      makeParsed("integrate", [item.id], { "dry-run": true }),
      git,
    );

    expect(result.status).toBe("success");
    if (result.status === "success") {
      const data = result.data as {
        dryRun: boolean;
        commands: string[];
        itemId: string;
        targetBranch: string;
      };
      expect(data.dryRun).toBe(true);
      expect(data.targetBranch).toBe("main");
      expect(data.commands).toBeArray();
      expect(data.commands.length).toBeGreaterThan(0);
      expect(result.humanOutput).toMatch(/^Dry run:/);
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
    const result = await integrateCommand(makeParsed("integrate", [item.id]), git);

    expect(result.status).toBe("error");
    if (result.status === "error") {
      expect(result.message).toContain("CONFLICT (content)");
    }
    expect(git.deleteBranch).not.toHaveBeenCalled();
    expect(git.worktreeRemove).not.toHaveBeenCalled();
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
    const result = await integrateCommand(makeParsed("integrate", [item.id]), git);

    expect(result.status).toBe("success");
    if (result.status === "success") {
      expect(result.warnings).toBeDefined();
      expect(result.warnings?.some((w) => w.includes("branch not fully merged"))).toBe(true);
    }
  });
});
