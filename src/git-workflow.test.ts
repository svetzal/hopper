import { describe, expect, test } from "bun:test";
import {
  buildEngineeringBranchName,
  buildWorkBranchName,
  resolveBranchSetup,
  resolveFfResult,
  resolveMergeCommitResult,
  resolveMergeStep,
} from "./git-workflow.ts";

describe("resolveBranchSetup", () => {
  test("uses existing branch when it exists locally", () => {
    const result = resolveBranchSetup("main", { localExists: true, remoteExists: false });
    expect(result).toEqual({ type: "use-existing" });
  });

  test("uses existing branch even when remote also exists", () => {
    const result = resolveBranchSetup("main", { localExists: true, remoteExists: true });
    expect(result).toEqual({ type: "use-existing" });
  });

  test("tracks remote when local is absent but remote exists", () => {
    const result = resolveBranchSetup("main", { localExists: false, remoteExists: true });
    expect(result).toEqual({ type: "track-remote", remoteRef: "origin/main" });
  });

  test("includes branch name in remoteRef for track-remote", () => {
    const result = resolveBranchSetup("feature/xyz", { localExists: false, remoteExists: true });
    expect(result).toEqual({ type: "track-remote", remoteRef: "origin/feature/xyz" });
  });

  test("creates from HEAD when neither local nor remote exists", () => {
    const result = resolveBranchSetup("main", { localExists: false, remoteExists: false });
    expect(result).toEqual({ type: "create-from-head" });
  });
});

describe("buildWorkBranchName", () => {
  test("uses first 8 characters of the item ID", () => {
    const result = buildWorkBranchName("abcdef12-0000-0000-0000-000000000000");
    expect(result).toBe("hopper/abcdef12");
  });

  test("handles a short ID without a hyphen", () => {
    const result = buildWorkBranchName("12345678abcd");
    expect(result).toBe("hopper/12345678");
  });

  test("prefixes with hopper/", () => {
    const result = buildWorkBranchName("aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee");
    expect(result).toMatch(/^hopper\//);
  });
});

describe("buildEngineeringBranchName", () => {
  test("uses slug plus id prefix when slug is provided", () => {
    const result = buildEngineeringBranchName(
      "abcdef12-0000-0000-0000-000000000000",
      "add-quiet-flag",
    );
    expect(result).toBe("hopper-eng/add-quiet-flag-abcdef12");
  });

  test("falls back to bare id prefix when slug is null", () => {
    const result = buildEngineeringBranchName("abcdef12-0000-0000-0000-000000000000", null);
    expect(result).toBe("hopper-eng/abcdef12");
  });

  test("falls back to bare id prefix when slug is empty string", () => {
    // Empty string is treated the same as null — nothing meaningful to use.
    const result = buildEngineeringBranchName("abcdef12-0000-0000-0000-000000000000", "");
    expect(result).toBe("hopper-eng/abcdef12");
  });
});

describe("resolveMergeStep", () => {
  test("returns attempt-ff when current branch matches target", () => {
    const result = resolveMergeStep("main", "main");
    expect(result).toEqual({ type: "attempt-ff" });
  });

  test("returns checkout-and-attempt-ff when current branch differs from target", () => {
    const result = resolveMergeStep("develop", "main");
    expect(result).toEqual({ type: "checkout-and-attempt-ff", originalBranch: "develop" });
  });

  test("checkout-and-attempt-ff preserves original branch name", () => {
    const result = resolveMergeStep("feature/xyz", "main");
    if (result.type === "checkout-and-attempt-ff") {
      expect(result.originalBranch).toBe("feature/xyz");
    }
  });
});

describe("resolveFfResult", () => {
  const ctx = { workBranch: "hopper/abcdef12", targetBranch: "main" };

  test("returns ff-succeeded with fast-forward outcome on exit code 0", () => {
    const result = resolveFfResult(0, ctx);
    expect(result.type).toBe("ff-succeeded");
    if (result.type === "ff-succeeded") {
      expect(result.outcome.type).toBe("fast-forward");
      expect(result.outcome.success).toBe(true);
    }
  });

  test("ff-succeeded message mentions work branch and target branch", () => {
    const result = resolveFfResult(0, ctx);
    if (result.type === "ff-succeeded") {
      expect(result.outcome.message).toContain("hopper/abcdef12");
      expect(result.outcome.message).toContain("main");
    }
  });

  test("returns attempt-merge-commit on non-zero exit code", () => {
    const result = resolveFfResult(1, ctx);
    expect(result).toEqual({ type: "attempt-merge-commit" });
  });

  test("returns attempt-merge-commit for any non-zero exit code", () => {
    const result = resolveFfResult(128, ctx);
    expect(result).toEqual({ type: "attempt-merge-commit" });
  });
});

describe("resolveMergeCommitResult", () => {
  const ctx = { workBranch: "hopper/abcdef12", targetBranch: "main" };

  test("returns merge-commit-succeeded with merge-commit outcome on exit code 0", () => {
    const result = resolveMergeCommitResult(0, ctx);
    expect(result.type).toBe("merge-commit-succeeded");
    if (result.type === "merge-commit-succeeded") {
      expect(result.outcome.type).toBe("merge-commit");
      expect(result.outcome.success).toBe(true);
    }
  });

  test("merge-commit-succeeded message mentions work branch and target branch", () => {
    const result = resolveMergeCommitResult(0, ctx);
    if (result.type === "merge-commit-succeeded") {
      expect(result.outcome.message).toContain("hopper/abcdef12");
      expect(result.outcome.message).toContain("main");
    }
  });

  test("returns conflict-abort with conflict outcome on non-zero exit code", () => {
    const result = resolveMergeCommitResult(1, ctx);
    expect(result.type).toBe("conflict-abort");
    if (result.type === "conflict-abort") {
      expect(result.outcome.type).toBe("conflict");
      expect(result.outcome.success).toBe(false);
    }
  });

  test("conflict-abort message mentions work branch and target branch", () => {
    const result = resolveMergeCommitResult(1, ctx);
    if (result.type === "conflict-abort") {
      expect(result.outcome.message).toContain("hopper/abcdef12");
      expect(result.outcome.message).toContain("main");
    }
  });

  test("returns conflict-abort for any non-zero exit code", () => {
    const result = resolveMergeCommitResult(255, ctx);
    expect(result.type).toBe("conflict-abort");
  });
});
