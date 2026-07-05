import { describe, expect, test } from "bun:test";
import { INVESTIGATION_DISALLOWED_TOOLS } from "../task-type-workflow.ts";
import {
  AWS_READONLY,
  buildAwsReadonlyShimScript,
  buildInvestigationShimMap,
  buildShimScript,
  parseDisallowedTools,
} from "./worker-shim-content.ts";

describe("parseDisallowedTools", () => {
  test("parses git verb patterns into a list of denied verbs", () => {
    const patterns = ["Bash(git commit:*)", "Bash(git push:*)", "Bash(git merge:*)"];
    const result = parseDisallowedTools(patterns);
    const gitVerbs = result.get("git");
    expect(gitVerbs).not.toBe("all");
    expect(Array.isArray(gitVerbs)).toBe(true);
    expect(gitVerbs).toContain("commit");
    expect(gitVerbs).toContain("push");
    expect(gitVerbs).toContain("merge");
  });

  test("parses single-token full-deny patterns (curl, wget) as 'all'", () => {
    const patterns = ["Bash(curl:*)", "Bash(wget:*)"];
    const result = parseDisallowedTools(patterns);
    expect(result.get("curl")).toBe("all");
    expect(result.get("wget")).toBe("all");
  });

  test("collapses package managers with multi-token verbs to full deny", () => {
    const patterns = [
      "Bash(npm install:*)",
      "Bash(npm i:*)",
      "Bash(bun install:*)",
      "Bash(bun add:*)",
      "Bash(pnpm add:*)",
      "Bash(pnpm install:*)",
      "Bash(yarn add:*)",
      "Bash(yarn install:*)",
      "Bash(pip install:*)",
      "Bash(uv pip:*)",
      "Bash(cargo install:*)",
      "Bash(brew install:*)",
      "Bash(brew upgrade:*)",
    ];
    const result = parseDisallowedTools(patterns);
    expect(result.get("npm")).toBe("all");
    expect(result.get("bun")).toBe("all");
    expect(result.get("pnpm")).toBe("all");
    expect(result.get("yarn")).toBe("all");
    expect(result.get("pip")).toBe("all");
    expect(result.get("uv")).toBe("all");
    expect(result.get("cargo")).toBe("all");
    expect(result.get("brew")).toBe("all");
  });

  test("skips non-Bash patterns", () => {
    const patterns = ["Read", "Glob", "WebFetch", "Bash(git commit:*)"];
    const result = parseDisallowedTools(patterns);
    expect(result.size).toBe(1);
    expect(result.has("git")).toBe(true);
  });

  test("processes a representative slice of INVESTIGATION_DISALLOWED_TOOLS", () => {
    const result = parseDisallowedTools(INVESTIGATION_DISALLOWED_TOOLS);
    // Git verbs must be collected as a list
    const gitVerbs = result.get("git");
    expect(gitVerbs).not.toBe("all");
    expect(Array.isArray(gitVerbs)).toBe(true);
    expect(gitVerbs).toContain("commit");
    expect(gitVerbs).toContain("push");
    expect(gitVerbs).toContain("rebase");
    expect(gitVerbs).toContain("checkout");

    // Hopper queue mutators
    const hopperVerbs = result.get("hopper");
    expect(hopperVerbs).not.toBe("all");
    expect(Array.isArray(hopperVerbs)).toBe(true);
    expect(hopperVerbs).toContain("add");
    expect(hopperVerbs).toContain("cancel");

    // Network egress tools are full-denied
    expect(result.get("curl")).toBe("all");
    expect(result.get("wget")).toBe("all");
    expect(result.get("gh")).toBe("all");
    expect(result.get("ssh")).toBe("all");

    // Package managers are full-denied
    expect(result.get("npm")).toBe("all");
    expect(result.get("bun")).toBe("all");
  });

  test("full-deny wins over verb-list when same binary appears in both forms", () => {
    // If a binary is first seen as a verb-list entry, then as a full-deny, full-deny wins
    const patterns = ["Bash(git commit:*)", "Bash(git:*)"];
    const result = parseDisallowedTools(patterns);
    expect(result.get("git")).toBe("all");
  });

  test("aws is no longer treated as full-deny — a multi-token aws pattern yields a verb list", () => {
    const result = parseDisallowedTools(["Bash(aws s3:*)"]);
    const awsVerbs = result.get("aws");
    expect(awsVerbs).not.toBe("all");
    expect(Array.isArray(awsVerbs)).toBe(true);
    expect(awsVerbs).toContain("s3");
  });
});

describe("buildInvestigationShimMap", () => {
  test("sets aws to AWS_READONLY regardless of the denylist contents", () => {
    const result = buildInvestigationShimMap(INVESTIGATION_DISALLOWED_TOOLS);
    expect(result.get("aws")).toBe(AWS_READONLY);
    expect(result.get("aws")).not.toBe("all");
  });

  test("still full-denies other network-egress binaries", () => {
    const result = buildInvestigationShimMap(INVESTIGATION_DISALLOWED_TOOLS);
    expect(result.get("curl")).toBe("all");
    expect(result.get("wget")).toBe("all");
  });
});

describe("buildShimScript", () => {
  test("full-deny script exits 1 unconditionally", () => {
    const script = buildShimScript("curl", "all");
    expect(script).toStartWith("#!/bin/sh");
    expect(script).toContain("exit 1");
    expect(script).not.toContain("exec env PATH=");
  });

  test("full-deny script includes the deny message with binary name", () => {
    const script = buildShimScript("curl", "all");
    expect(script).toContain("hopper-worker-shim: 'curl' is denied in investigation sessions");
  });

  test("verb-list script uses case statement and allows pass-through", () => {
    const script = buildShimScript("git", ["commit", "push", "merge"]);
    expect(script).toStartWith("#!/bin/sh");
    expect(script).toContain('case "$1"');
    expect(script).toContain("commit)");
    expect(script).toContain("push)");
    expect(script).toContain("merge)");
  });

  test("verb-list script re-execs using HOPPER_REAL_PATH (not hard-coded path)", () => {
    const script = buildShimScript("git", ["commit"]);
    expect(script).toContain("$HOPPER_REAL_PATH");
    expect(script).not.toMatch(/PATH=\/usr\/|PATH=\/bin|PATH=\/opt/);
  });

  test("verb-list script includes deny message with binary and verb", () => {
    const script = buildShimScript("git", ["commit", "push"]);
    expect(script).toContain(
      "hopper-worker-shim: 'git commit' is denied in investigation sessions",
    );
    expect(script).toContain("hopper-worker-shim: 'git push' is denied in investigation sessions");
  });

  test("verb-list re-exec line passes all args through", () => {
    const script = buildShimScript("git", ["commit"]);
    expect(script).toContain('"$@"');
  });

  test("verb-list passes non-denied verbs through to real binary", () => {
    const script = buildShimScript("git", ["commit"]);
    // The exec line should delegate to the real git with all args
    expect(script).toContain('exec env PATH="$HOPPER_REAL_PATH" git "$@"');
  });

  test("dispatches to the aws read-only shim for the AWS_READONLY sentinel", () => {
    const script = buildShimScript("aws", AWS_READONLY);
    expect(script).toBe(buildAwsReadonlyShimScript());
  });
});

describe("buildAwsReadonlyShimScript", () => {
  const script = buildAwsReadonlyShimScript();

  test("starts with the POSIX shebang", () => {
    expect(script).toStartWith("#!/bin/sh");
  });

  test("allows clearly read-only action patterns", () => {
    expect(script).toContain("get-*|describe-*|list-*|query|scan|batch-get-item");
  });

  test("delegates to the real binary via HOPPER_REAL_PATH for allowed calls", () => {
    expect(script).toContain('exec env PATH="$HOPPER_REAL_PATH" aws "$@"');
  });

  test("includes the standard deny message format for mutating actions", () => {
    expect(script).toContain(
      "hopper-worker-shim: 'aws $action' is denied in investigation sessions",
    );
  });

  test("never shifts positional args before the final exec (preserves original argv)", () => {
    expect(script).not.toContain("shift");
  });
});
