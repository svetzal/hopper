import { describe, expect, test } from "bun:test";
import { StaleEngineeringBranchError } from "./engineering-errors.ts";

describe("StaleEngineeringBranchError", () => {
  test("is an instance of Error with the correct name", () => {
    const err = new StaleEngineeringBranchError("my-branch", []);
    expect(err instanceof Error).toBe(true);
    expect(err.name).toBe("StaleEngineeringBranchError");
  });

  test("exposes branch and worktreePaths as readonly fields", () => {
    const paths = ["/work/a", "/work/b"];
    const err = new StaleEngineeringBranchError("feat/x", paths);
    expect(err.branch).toBe("feat/x");
    expect(err.worktreePaths).toBe(paths);
  });

  test("message includes branch name and joined paths when worktreePaths is non-empty", () => {
    const err = new StaleEngineeringBranchError("feat/x", ["/work/a", "/work/b"]);
    expect(err.message).toContain("feat/x");
    expect(err.message).toContain("still referenced by active worktrees");
    expect(err.message).toContain("/work/a");
    expect(err.message).toContain("/work/b");
  });

  test("message uses diverged-branch wording when worktreePaths is empty", () => {
    const err = new StaleEngineeringBranchError("feat/x", []);
    expect(err.message).toContain("feat/x");
    expect(err.message).toContain("already exists but has diverged");
    expect(err.message).not.toContain("active worktrees");
  });
});
