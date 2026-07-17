import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { buildEngineeringBranchName } from "../git-workflow.ts";
import { addItem, saveItems } from "../store.ts";
import { makeItem, makeMockGit, makeParsed, setupTempStoreDir } from "../test-helpers.ts";
import { cancelCommand } from "./cancel.ts";

describe("cancelCommand", () => {
  const storeDir = setupTempStoreDir("hopper-cancel-test-");

  beforeEach(storeDir.beforeEach);
  afterEach(storeDir.afterEach);

  test("returns error when no id is provided", async () => {
    const result = await cancelCommand(makeParsed("cancel", []));
    expect(result.status).toBe("error");
    if (result.status === "error") {
      expect(result.message).toBe("Usage: hopper cancel <item-id>");
    }
  });

  test("returns success with humanOutput on successful cancel", async () => {
    const item = makeItem();
    await addItem(item);

    const result = await cancelCommand(makeParsed("cancel", [item.id]));

    expect(result.status).toBe("success");
    if (result.status === "success") {
      expect(result.humanOutput).toBe(`Cancelled: ${item.title}`);
      expect(result.warnings).toBeUndefined();
    }
  });

  test("includes recurrence stopped note when item has recurrence", async () => {
    const item = makeItem({
      recurrence: { interval: "1d", intervalMs: 86400000 },
    });
    await addItem(item);

    const result = await cancelCommand(makeParsed("cancel", [item.id]));

    expect(result.status).toBe("success");
    if (result.status === "success") {
      expect(result.humanOutput).toBe(`Cancelled: ${item.title} (recurrence stopped)`);
    }
  });

  test("includes warning when blocked dependents exist", async () => {
    const dep = makeItem({ id: "aaaaaaaa-0000-0000-0000-000000000001" });
    const blocked = makeItem({
      status: "blocked",
      dependsOn: [dep.id],
    });
    await saveItems([dep, blocked]);

    const result = await cancelCommand(makeParsed("cancel", [dep.id]));

    expect(result.status).toBe("success");
    if (result.status === "success") {
      expect(result.warnings).toEqual([
        "Warning: 1 item(s) depend on this item and will remain blocked.",
      ]);
    }
  });

  test("returns error from store when item cannot be cancelled", async () => {
    const item = makeItem({ status: "completed" });
    await addItem(item);

    const result = await cancelCommand(makeParsed("cancel", [item.id]));
    expect(result.status).toBe("error");
    if (result.status === "error") {
      expect(result.message).toContain(
        "Only queued, scheduled, blocked, in-progress, or failed items can be cancelled",
      );
    }
  });

  test("cancels an in_progress non-engineering item without touching git", async () => {
    const item = makeItem({ status: "in_progress" });
    await addItem(item);
    const git = makeMockGit();

    const result = await cancelCommand(makeParsed("cancel", [item.id]), git);

    expect(result.status).toBe("success");
    if (result.status === "success") {
      expect(result.warnings).toBeUndefined();
    }
    expect(git.worktreeRemove).not.toHaveBeenCalled();
    expect(git.forceDeleteBranch).not.toHaveBeenCalled();
  });

  test("cancelling an in_progress engineering item tears down its worktree and branch", async () => {
    const workingDir = "/repo";
    const item = makeItem({
      status: "in_progress",
      type: "engineering",
      workingDir,
      branch: "main",
      engineeringBranchSlug: "fix-thing",
    });
    await addItem(item);
    const git = makeMockGit();

    // isDirectory => true so the worktree-removal path runs.
    const result = await cancelCommand(
      makeParsed("cancel", [item.id], { yes: true }),
      git,
      async () => true,
    );

    expect(result.status).toBe("success");
    if (result.status === "success") {
      expect(result.warnings).toBeUndefined();
    }
    const workBranch = buildEngineeringBranchName(item.id, "fix-thing");
    expect(git.worktreeRemove).toHaveBeenCalledTimes(1);
    expect(git.forceDeleteBranch).toHaveBeenCalledWith(workingDir, workBranch);
  });

  test("skips worktree removal when the directory is absent but still deletes the branch", async () => {
    const item = makeItem({
      status: "in_progress",
      type: "engineering",
      workingDir: "/repo",
      branch: "main",
    });
    await addItem(item);
    const git = makeMockGit();

    const result = await cancelCommand(
      makeParsed("cancel", [item.id], { yes: true }),
      git,
      async () => false,
    );

    expect(result.status).toBe("success");
    expect(git.worktreeRemove).not.toHaveBeenCalled();
    expect(git.forceDeleteBranch).toHaveBeenCalledTimes(1);
  });

  test("surfaces a warning when worktree teardown fails, but still cancels", async () => {
    const item = makeItem({
      status: "in_progress",
      type: "engineering",
      workingDir: "/repo",
      branch: "main",
    });
    await addItem(item);
    const git = makeMockGit({
      worktreeRemove: mock(async () => {
        throw new Error("worktree busy");
      }),
    });

    const result = await cancelCommand(
      makeParsed("cancel", [item.id], { yes: true }),
      git,
      async () => true,
    );

    expect(result.status).toBe("success");
    if (result.status === "success") {
      expect(result.warnings).toBeDefined();
      expect(result.warnings?.some((w) => w.includes("Could not remove worktree"))).toBe(true);
    }
    // Branch deletion is still attempted even after a worktree-removal failure.
    expect(git.forceDeleteBranch).toHaveBeenCalledTimes(1);
  });

  test("destructive cancel without --yes aborts when confirmation is declined", async () => {
    const item = makeItem({
      status: "in_progress",
      type: "engineering",
      workingDir: "/repo",
      branch: "main",
      engineeringBranchSlug: "risky",
    });
    await addItem(item);
    const git = makeMockGit();

    // confirm => false (models a declined prompt, or a non-interactive caller).
    const result = await cancelCommand(
      makeParsed("cancel", [item.id]),
      git,
      async () => true,
      async () => false,
    );

    expect(result.status).toBe("error");
    if (result.status === "error") {
      expect(result.message).toContain("aborted");
      expect(result.message).toContain("--yes");
    }
    // Nothing was torn down and the item was NOT transitioned.
    expect(git.forceDeleteBranch).not.toHaveBeenCalled();
    expect(git.worktreeRemove).not.toHaveBeenCalled();
  });

  test("destructive cancel proceeds when confirmation is approved", async () => {
    const item = makeItem({
      status: "in_progress",
      type: "engineering",
      workingDir: "/repo",
      branch: "main",
      engineeringBranchSlug: "ok-to-drop",
    });
    await addItem(item);
    const git = makeMockGit();

    const result = await cancelCommand(
      makeParsed("cancel", [item.id]),
      git,
      async () => true,
      async () => true,
    );

    expect(result.status).toBe("success");
    expect(git.forceDeleteBranch).toHaveBeenCalledTimes(1);
  });

  test("--yes skips the confirmation prompt entirely", async () => {
    const item = makeItem({
      status: "in_progress",
      type: "engineering",
      workingDir: "/repo",
      branch: "main",
      engineeringBranchSlug: "yes-flag",
    });
    await addItem(item);
    const git = makeMockGit();

    // A confirm that throws proves the prompt is never consulted when --yes is set.
    const result = await cancelCommand(
      makeParsed("cancel", [item.id], { yes: true }),
      git,
      async () => true,
      async () => {
        throw new Error("confirm must not be called when --yes is set");
      },
    );

    expect(result.status).toBe("success");
    expect(git.forceDeleteBranch).toHaveBeenCalledTimes(1);
  });
});
