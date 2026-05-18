import { describe, expect, mock, test } from "bun:test";
import type { Profile } from "./profile.ts";
import type { Item } from "./store.ts";
import {
  buildBranchSlugPrompt,
  buildCommitMessagePrompt,
  buildExecuteOptions,
  buildExecutePrompt,
  buildInvestigationOptions,
  buildInvestigationPrompt,
  buildPlanOptions,
  buildPlanPrompt,
  buildValidateFallbackPrompt,
  buildValidateOptions,
  buildValidatePrompt,
  EXECUTE_DISALLOWED_TOOLS,
  INVESTIGATION_TOOLS,
  normaliseBranchSlug,
  normaliseCommitMessage,
  normaliseValidateFallback,
  PLAN_TOOLS,
  resolveValidateOutcome,
  resolveValidateOutcomeWithFallback,
  VALIDATE_ALLOWED_TOOLS,
  VALIDATE_TOOLS,
} from "./task-type-workflow.ts";
import { makeItem } from "./test-helpers.ts";

const TEST_PROFILE: Profile = {
  name: "test",
  runner: "claude",
  models: {
    deep: { model: "opus" },
    balanced: { model: "sonnet" },
    fast: { model: "haiku" },
  },
};

function makeInvestigationItem() {
  return makeItem({
    id: "abcdef12-0000-0000-0000-000000000000",
    title: "Investigate cache misses",
    description: "Figure out why the in-memory cache never hits.",
    createdAt: "2026-01-01T00:00:00Z",
    type: "investigation",
  });
}

describe("buildInvestigationPrompt", () => {
  test("includes the item title and description verbatim", () => {
    const prompt = buildInvestigationPrompt(makeInvestigationItem());
    expect(prompt).toContain("Investigate cache misses");
    expect(prompt).toContain("Figure out why the in-memory cache never hits.");
  });

  test("states that the deliverable is a markdown findings report", () => {
    const prompt = buildInvestigationPrompt(makeInvestigationItem());
    expect(prompt.toLowerCase()).toContain("markdown");
    expect(prompt.toLowerCase()).toContain("findings");
  });

  test("explicitly forbids mutating the filesystem", () => {
    const prompt = buildInvestigationPrompt(makeInvestigationItem());
    expect(prompt.toLowerCase()).toContain("read-only");
  });

  test("tells the agent its final message is captured as the result", () => {
    const prompt = buildInvestigationPrompt(makeInvestigationItem());
    expect(prompt.toLowerCase()).toContain("final message");
  });
});

describe("buildInvestigationOptions", () => {
  test("uses the deep tier for strong reasoning on open-ended questions", () => {
    expect(buildInvestigationOptions().model).toBe("deep");
  });

  test("uses plan permission mode to prevent mutations", () => {
    expect(buildInvestigationOptions().permissionMode).toBe("plan");
  });

  test("scopes tools to the read-only allowlist", () => {
    expect(buildInvestigationOptions().tools).toEqual([...INVESTIGATION_TOOLS]);
  });

  test("does not include Edit, Write, or Bash in the tool set", () => {
    const { tools } = buildInvestigationOptions();
    expect(tools).not.toContain("Edit");
    expect(tools).not.toContain("Write");
    expect(tools).not.toContain("Bash");
  });

  test("uses high reasoning effort", () => {
    expect(buildInvestigationOptions().effort).toBe("high");
  });
});

describe("INVESTIGATION_TOOLS", () => {
  test("contains the expected read-only tool names", () => {
    expect(INVESTIGATION_TOOLS).toEqual(["Read", "Grep", "Glob", "WebFetch", "WebSearch", "Task"]);
  });
});

// ---------------------------------------------------------------------------
// Engineering: plan phase
// ---------------------------------------------------------------------------

function makeEngItem(overrides?: Partial<Item>): Item {
  return {
    id: "11111111-2222-3333-4444-555555555555",
    title: "Add --quiet flag",
    description: "Suppress non-error output when --quiet is set on the CLI.",
    status: "queued",
    createdAt: "2026-02-01T00:00:00Z",
    type: "engineering",
    ...overrides,
  };
}

describe("buildPlanPrompt", () => {
  test("includes item title and description", () => {
    const prompt = buildPlanPrompt(makeEngItem());
    expect(prompt).toContain("Add --quiet flag");
    expect(prompt).toContain("Suppress non-error output");
  });

  test("instructs the agent to emit a plan as the final message", () => {
    const prompt = buildPlanPrompt(makeEngItem());
    expect(prompt.toLowerCase()).toContain("final");
    expect(prompt.toLowerCase()).toContain("plan");
  });

  test("forbids writing files", () => {
    const prompt = buildPlanPrompt(makeEngItem());
    expect(prompt).toContain("Do NOT write");
  });

  test("asks for validation commands explicitly", () => {
    const prompt = buildPlanPrompt(makeEngItem());
    expect(prompt.toLowerCase()).toContain("validation commands");
  });
});

describe("buildPlanOptions", () => {
  test("uses the deep tier in plan permission mode with read-only tools", () => {
    const opts = buildPlanOptions();
    expect(opts.model).toBe("deep");
    expect(opts.permissionMode).toBe("plan");
    expect(opts.tools).toEqual([...PLAN_TOOLS]);
  });

  test("plan tool set has no Write, Edit, or Bash", () => {
    const opts = buildPlanOptions();
    expect(opts.tools).not.toContain("Write");
    expect(opts.tools).not.toContain("Edit");
    expect(opts.tools).not.toContain("Bash");
  });

  test("uses high reasoning effort", () => {
    expect(buildPlanOptions().effort).toBe("high");
  });
});

// ---------------------------------------------------------------------------
// Engineering: execute phase
// ---------------------------------------------------------------------------

describe("buildExecutePrompt", () => {
  test("inlines the plan text verbatim", () => {
    const plan = "## Approach\nUse a new --quiet flag handled in cli.ts.";
    const prompt = buildExecutePrompt(makeEngItem(), plan);
    expect(prompt).toContain(plan);
  });

  test("forbids the agent from mutating git", () => {
    const prompt = buildExecutePrompt(makeEngItem(), "plan");
    expect(prompt.toLowerCase()).toContain("do not commit");
    expect(prompt.toLowerCase()).toContain("hopper owns all git");
  });
});

describe("buildExecuteOptions", () => {
  test("defaults to the balanced tier and forwards agent when provided", () => {
    const opts = buildExecuteOptions("typescript-bun-cli-craftsperson");
    expect(opts.model).toBe("balanced");
    expect(opts.agent).toBe("typescript-bun-cli-craftsperson");
  });

  test("omits agent when none provided", () => {
    const opts = buildExecuteOptions();
    expect(opts.agent).toBeUndefined();
  });

  test("disallows git-mutating Bash patterns", () => {
    const opts = buildExecuteOptions();
    expect(opts.disallowedTools).toEqual([...EXECUTE_DISALLOWED_TOOLS]);
    expect(opts.disallowedTools).toContain("Bash(git commit:*)");
    expect(opts.disallowedTools).toContain("Bash(git push:*)");
    expect(opts.disallowedTools).toContain("Bash(git merge:*)");
  });

  test("uses medium reasoning effort", () => {
    expect(buildExecuteOptions().effort).toBe("medium");
  });
});

// ---------------------------------------------------------------------------
// Engineering: validate phase
// ---------------------------------------------------------------------------

describe("buildValidatePrompt", () => {
  test("inlines the plan text", () => {
    const plan = "## Validation\nRun bun test and bun run lint.";
    const prompt = buildValidatePrompt(makeEngItem(), plan);
    expect(prompt).toContain(plan);
  });

  test("requires a PASS/FAIL terminator", () => {
    const prompt = buildValidatePrompt(makeEngItem(), "plan");
    expect(prompt).toContain("VALIDATE: PASS");
    expect(prompt).toContain("VALIDATE: FAIL");
  });

  test("forbids git mutations", () => {
    const prompt = buildValidatePrompt(makeEngItem(), "plan");
    expect(prompt.toLowerCase()).toContain("do not mutate git");
  });
});

describe("buildValidateOptions", () => {
  test("uses the deep tier with a tool set that includes read-only git", () => {
    const opts = buildValidateOptions();
    expect(opts.model).toBe("deep");
    expect(opts.tools).toEqual([...VALIDATE_TOOLS]);
    expect(opts.allowedTools).toEqual([...VALIDATE_ALLOWED_TOOLS]);
  });

  test("allows read-only git commands only", () => {
    const { allowedTools } = buildValidateOptions();
    expect(allowedTools).toContain("Bash(git diff:*)");
    expect(allowedTools).toContain("Bash(git status:*)");
    expect(allowedTools).not.toContain("Bash(git commit:*)");
    expect(allowedTools).not.toContain("Bash(git push:*)");
  });

  test("explicitly denies git-mutating Bash patterns", () => {
    const opts = buildValidateOptions();
    expect(opts.disallowedTools).toEqual([...EXECUTE_DISALLOWED_TOOLS]);
  });

  test("uses high reasoning effort", () => {
    expect(buildValidateOptions().effort).toBe("high");
  });
});

describe("resolveValidateOutcome", () => {
  test("passes when exit is 0 and message ends with VALIDATE: PASS", () => {
    const outcome = resolveValidateOutcome(0, "All good.\n\nVALIDATE: PASS\n");
    expect(outcome.passed).toBe(true);
  });

  test("fails when exit is non-zero regardless of message", () => {
    const outcome = resolveValidateOutcome(1, "VALIDATE: PASS");
    expect(outcome.passed).toBe(false);
    expect(outcome.reason).toContain("exited 1");
  });

  test("fails when message explicitly says VALIDATE: FAIL", () => {
    const outcome = resolveValidateOutcome(0, "Lint errors found.\n\nVALIDATE: FAIL");
    expect(outcome.passed).toBe(false);
    expect(outcome.reason).toContain("FAIL");
  });

  test("fails when no marker is present — ambiguity is a failure", () => {
    const outcome = resolveValidateOutcome(0, "Seems fine to me!");
    expect(outcome.passed).toBe(false);
    expect(outcome.reason.toLowerCase()).toContain("marker");
  });

  test("treats a doc-comment mentioning both markers as unreliable", () => {
    // FAIL wins when both tokens appear (conservative default).
    const outcome = resolveValidateOutcome(
      0,
      "Saw `VALIDATE: PASS` in docs earlier.\n\nVALIDATE: FAIL\n",
    );
    expect(outcome.passed).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Haiku helpers
// ---------------------------------------------------------------------------

describe("buildBranchSlugPrompt", () => {
  test("includes title and description", () => {
    const prompt = buildBranchSlugPrompt("Add --quiet flag", "Silence informational output.");
    expect(prompt).toContain("Add --quiet flag");
    expect(prompt).toContain("Silence informational output.");
  });

  test("asks for kebab-case and nothing else", () => {
    const prompt = buildBranchSlugPrompt("t", "d");
    expect(prompt.toLowerCase()).toContain("kebab-case");
    expect(prompt).toContain("ONLY the slug");
  });
});

describe("normaliseBranchSlug", () => {
  test("lowercases and hyphenates whitespace", () => {
    expect(normaliseBranchSlug("Add Quiet Flag")).toBe("add-quiet-flag");
  });

  test("strips surrounding punctuation and trailing periods", () => {
    expect(normaliseBranchSlug("  add-quiet-flag.  ")).toBe("add-quiet-flag");
  });

  test("collapses runs of hyphens", () => {
    expect(normaliseBranchSlug("foo---bar")).toBe("foo-bar");
  });

  test("drops non-[a-z0-9-] characters", () => {
    expect(normaliseBranchSlug("Add --quiet & --loud")).toBe("add-quiet-loud");
  });

  test("returns null for unusable input", () => {
    expect(normaliseBranchSlug("")).toBeNull();
    expect(normaliseBranchSlug("!!!")).toBeNull();
    expect(normaliseBranchSlug("   ")).toBeNull();
  });

  test("caps slug length at 60 chars and trims trailing hyphen", () => {
    const long = "a".repeat(100);
    const result = normaliseBranchSlug(long);
    expect(result).not.toBeNull();
    expect((result as string).length).toBeLessThanOrEqual(60);
  });
});

describe("buildCommitMessagePrompt", () => {
  test("includes title, description, and diff summary", () => {
    const prompt = buildCommitMessagePrompt(
      "Add --quiet flag",
      "Silence output when set.",
      "src/cli.ts | 10 +++++-----\n1 file changed",
    );
    expect(prompt).toContain("Add --quiet flag");
    expect(prompt).toContain("Silence output when set.");
    expect(prompt).toContain("1 file changed");
  });

  test("asks for conventional-commit style and body separation", () => {
    const prompt = buildCommitMessagePrompt("t", "d", "diff");
    expect(prompt.toLowerCase()).toContain("conventional-commit");
    expect(prompt.toLowerCase()).toContain("blank line");
  });
});

describe("normaliseCommitMessage", () => {
  test("returns the trimmed message when no fences", () => {
    expect(normaliseCommitMessage("  Add --quiet flag\n\nDetails.  ")).toBe(
      "Add --quiet flag\n\nDetails.",
    );
  });

  test("strips triple-backtick fences", () => {
    const raw = "```\nAdd --quiet flag\n\nDetails.\n```";
    expect(normaliseCommitMessage(raw)).toBe("Add --quiet flag\n\nDetails.");
  });

  test("strips language-tagged fences", () => {
    const raw = "```text\nAdd --quiet flag\n```";
    expect(normaliseCommitMessage(raw)).toBe("Add --quiet flag");
  });

  test("drops leading Subject: / Commit: labels", () => {
    expect(normaliseCommitMessage("Subject: Add flag")).toBe("Add flag");
    expect(normaliseCommitMessage("Commit: Add flag")).toBe("Add flag");
    expect(normaliseCommitMessage("Commit message: Add flag")).toBe("Add flag");
  });
});

// ---------------------------------------------------------------------------
// Haiku fallback assessor
// ---------------------------------------------------------------------------

describe("buildValidateFallbackPrompt", () => {
  test("includes the verbatim result text in the prompt", () => {
    const result = "Everything looks good but forgot the marker.";
    const prompt = buildValidateFallbackPrompt(result);
    expect(prompt).toContain(result);
  });

  test("instructs the model to respond with only PASS, FAIL, or UNCLEAR", () => {
    const prompt = buildValidateFallbackPrompt("some output");
    expect(prompt).toContain("PASS");
    expect(prompt).toContain("FAIL");
    expect(prompt).toContain("UNCLEAR");
    expect(prompt.toLowerCase()).toContain("only one word");
  });

  test("describes PASS signal phrases in the prompt", () => {
    const prompt = buildValidateFallbackPrompt("text");
    expect(prompt.toLowerCase()).toContain("all checks pass");
    expect(prompt.toLowerCase()).toContain("tests are green");
  });

  test("describes FAIL signal phrases in the prompt", () => {
    const prompt = buildValidateFallbackPrompt("text");
    expect(prompt.toLowerCase()).toContain("failed");
    expect(prompt.toLowerCase()).toContain("broken");
    expect(prompt.toLowerCase()).toContain("regression");
  });
});

describe("normaliseValidateFallback", () => {
  test("maps exact PASS token to PASS", () => {
    expect(normaliseValidateFallback("PASS")).toBe("PASS");
  });

  test("maps exact FAIL token to FAIL", () => {
    expect(normaliseValidateFallback("FAIL")).toBe("FAIL");
  });

  test("maps exact UNCLEAR token to UNCLEAR", () => {
    expect(normaliseValidateFallback("UNCLEAR")).toBe("UNCLEAR");
  });

  test("trims surrounding whitespace before matching", () => {
    expect(normaliseValidateFallback("  pass  ")).toBe("PASS");
    expect(normaliseValidateFallback("  fail  ")).toBe("FAIL");
    expect(normaliseValidateFallback("  unclear  ")).toBe("UNCLEAR");
  });

  test("is case-insensitive", () => {
    expect(normaliseValidateFallback("Pass")).toBe("PASS");
    expect(normaliseValidateFallback("Fail")).toBe("FAIL");
  });

  test("maps garbage or multi-word responses to UNCLEAR", () => {
    expect(normaliseValidateFallback("I think it passes")).toBe("UNCLEAR");
    expect(normaliseValidateFallback("UNKNOWN")).toBe("UNCLEAR");
    expect(normaliseValidateFallback("")).toBe("UNCLEAR");
  });
});

describe("resolveValidateOutcomeWithFallback", () => {
  function makeClaudeMock(text = "PASS", exitCode = 0) {
    return { generateText: mock(async () => ({ exitCode, text })) };
  }

  test("direct VALIDATE: PASS marker → no fallback invoked, fallbackUsed falsy, reason unchanged", async () => {
    const claude = makeClaudeMock();
    const outcome = await resolveValidateOutcomeWithFallback(
      0,
      "All good.\n\nVALIDATE: PASS\n",
      claude,
      TEST_PROFILE,
    );
    expect(outcome.passed).toBe(true);
    expect(outcome.reason).toBe("validate reported PASS");
    expect(outcome.fallbackUsed).toBeFalsy();
    expect(claude.generateText).not.toHaveBeenCalled();
  });

  test("direct VALIDATE: FAIL marker → no fallback invoked", async () => {
    const claude = makeClaudeMock();
    const outcome = await resolveValidateOutcomeWithFallback(
      0,
      "Errors found.\n\nVALIDATE: FAIL\n",
      claude,
      TEST_PROFILE,
    );
    expect(outcome.passed).toBe(false);
    expect(outcome.reason).toContain("FAIL");
    expect(outcome.fallbackUsed).toBeFalsy();
    expect(claude.generateText).not.toHaveBeenCalled();
  });

  test("exitCode !== 0 → no fallback invoked", async () => {
    const claude = makeClaudeMock();
    const outcome = await resolveValidateOutcomeWithFallback(
      1,
      "VALIDATE: PASS",
      claude,
      TEST_PROFILE,
    );
    expect(outcome.passed).toBe(false);
    expect(outcome.reason).toContain("exited 1");
    expect(outcome.fallbackUsed).toBeFalsy();
    expect(claude.generateText).not.toHaveBeenCalled();
  });

  test("no marker + Haiku returns PASS → passed: true, reason mentions fallback, fallbackUsed: true", async () => {
    const claude = makeClaudeMock("PASS");
    const outcome = await resolveValidateOutcomeWithFallback(
      0,
      "Seems fine to me!",
      claude,
      TEST_PROFILE,
    );
    expect(outcome.passed).toBe(true);
    expect(outcome.reason.toLowerCase()).toContain("fallback");
    expect(outcome.fallbackUsed).toBe(true);
    expect(claude.generateText).toHaveBeenCalledTimes(1);
  });

  test("no marker + Haiku returns FAIL → passed: false, reason mentions fallback", async () => {
    const claude = makeClaudeMock("FAIL");
    const outcome = await resolveValidateOutcomeWithFallback(
      0,
      "Something went wrong.",
      claude,
      TEST_PROFILE,
    );
    expect(outcome.passed).toBe(false);
    expect(outcome.reason.toLowerCase()).toContain("fallback");
    expect(outcome.fallbackUsed).toBe(true);
  });

  test("no marker + Haiku returns UNCLEAR → passed: false, reason mentions defaulting to FAIL", async () => {
    const claude = makeClaudeMock("UNCLEAR");
    const outcome = await resolveValidateOutcomeWithFallback(
      0,
      "Maybe it works?",
      claude,
      TEST_PROFILE,
    );
    expect(outcome.passed).toBe(false);
    expect(outcome.reason.toLowerCase()).toContain("defaulting to fail");
    expect(outcome.fallbackUsed).toBe(true);
  });

  test("no marker + Haiku returns whitespace-padded 'pass' → normalised to PASS → passed: true", async () => {
    const claude = makeClaudeMock("  pass  ");
    const outcome = await resolveValidateOutcomeWithFallback(0, "All clear.", claude, TEST_PROFILE);
    expect(outcome.passed).toBe(true);
    expect(outcome.fallbackUsed).toBe(true);
  });

  test("no marker + Haiku returns garbage like 'I think it passes' → UNCLEAR → safe-default FAIL", async () => {
    const claude = makeClaudeMock("I think it passes");
    const outcome = await resolveValidateOutcomeWithFallback(
      0,
      "The agent rambled.",
      claude,
      TEST_PROFILE,
    );
    expect(outcome.passed).toBe(false);
    expect(outcome.reason.toLowerCase()).toContain("defaulting to fail");
    expect(outcome.fallbackUsed).toBe(true);
  });

  test("no marker + claude.generateText rejects → caught → safe-default FAIL", async () => {
    const claude = {
      generateText: mock(async () => {
        throw new Error("network error");
      }),
    };
    const outcome = await resolveValidateOutcomeWithFallback(
      0,
      "No marker here.",
      claude,
      TEST_PROFILE,
    );
    expect(outcome.passed).toBe(false);
    expect(outcome.reason.toLowerCase()).toContain("defaulting to fail");
    expect(outcome.fallbackUsed).toBe(true);
  });

  test("no marker + Haiku exitCode !== 0 → safe-default FAIL", async () => {
    const claude = makeClaudeMock("PASS", 1);
    const outcome = await resolveValidateOutcomeWithFallback(
      0,
      "Something unclear.",
      claude,
      TEST_PROFILE,
    );
    expect(outcome.passed).toBe(false);
    expect(outcome.reason.toLowerCase()).toContain("defaulting to fail");
    expect(outcome.fallbackUsed).toBe(true);
  });
});
