import { describe, expect, mock, test } from "bun:test";
import type { AgentRunner } from "../gateways/agent-runner.ts";
import type { Profile } from "../profile.ts";
import { makeClaimedItem } from "../test-helpers.ts";
import {
  resolveEngineeringBranchSlug,
  resolveEngineeringCommitMessage,
  resolveValidateOutcomeWithFallback,
  safeGenerateText,
} from "./worker-engineering-text.ts";

const TEST_PROFILE: Profile = {
  name: "test",
  runner: "claude",
  models: { deep: { model: "opus" }, balanced: { model: "sonnet" }, fast: { model: "haiku" } },
};

const noop: (msg: string) => void = () => {};

// ---------------------------------------------------------------------------
// safeGenerateText
// ---------------------------------------------------------------------------

describe("safeGenerateText", () => {
  test("success → returns { ok: true, text }", async () => {
    const claude: AgentRunner = {
      runSession: mock(async () => ({ exitCode: 0, result: "" })),
      generateText: mock(async () => ({ exitCode: 0, text: "hello" })),
    };

    const result = await safeGenerateText(claude, "prompt", TEST_PROFILE, "Test", noop);

    expect(result).toEqual({ ok: true, text: "hello" });
  });

  test("exitCode !== 0 → returns { ok: false } and logs failure with label and exit code", async () => {
    const claude: AgentRunner = {
      runSession: mock(async () => ({ exitCode: 0, result: "" })),
      generateText: mock(async () => ({ exitCode: 2, text: "" })),
    };
    const logs: string[] = [];

    const result = await safeGenerateText(
      claude,
      "prompt",
      TEST_PROFILE,
      "My label",
      (msg) => logs.push(msg),
    );

    expect(result).toEqual({ ok: false });
    expect(logs.some((l) => l.includes("My label") && l.includes("exit 2"))).toBe(true);
  });

  test("generateText throws → returns { ok: false } and logs label with error message", async () => {
    const claude: AgentRunner = {
      runSession: mock(async () => ({ exitCode: 0, result: "" })),
      generateText: mock(async () => {
        throw new Error("network down");
      }),
    };
    const logs: string[] = [];

    const result = await safeGenerateText(
      claude,
      "prompt",
      TEST_PROFILE,
      "My label",
      (msg) => logs.push(msg),
    );

    expect(result).toEqual({ ok: false });
    expect(logs.some((l) => l.includes("My label") && l.includes("network down"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// resolveEngineeringBranchSlug
// ---------------------------------------------------------------------------

describe("resolveEngineeringBranchSlug", () => {
  test("success → returns normalised slug", async () => {
    const claude: AgentRunner = {
      runSession: mock(async () => ({ exitCode: 0, result: "" })),
      generateText: mock(async () => ({ exitCode: 0, text: "My Feature Slug" })),
    };
    const item = makeClaimedItem();

    const slug = await resolveEngineeringBranchSlug(claude, TEST_PROFILE, item, noop);

    expect(slug).toBe("my-feature-slug");
  });

  test("safeGenerateText failure → returns null", async () => {
    const claude: AgentRunner = {
      runSession: mock(async () => ({ exitCode: 0, result: "" })),
      generateText: mock(async () => ({ exitCode: 1, text: "" })),
    };
    const item = makeClaimedItem();

    const slug = await resolveEngineeringBranchSlug(claude, TEST_PROFILE, item, noop);

    expect(slug).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// resolveEngineeringCommitMessage
// ---------------------------------------------------------------------------

describe("resolveEngineeringCommitMessage", () => {
  test("success → returns resolved commit message", async () => {
    const claude: AgentRunner = {
      runSession: mock(async () => ({ exitCode: 0, result: "" })),
      generateText: mock(async () => ({ exitCode: 0, text: "feat: implement feature" })),
    };
    const item = makeClaimedItem({ title: "fallback title" });

    const msg = await resolveEngineeringCommitMessage(claude, TEST_PROFILE, item, "diff", noop);

    expect(msg).toBe("feat: implement feature");
  });

  test("safeGenerateText failure → falls back to item.title", async () => {
    const claude: AgentRunner = {
      runSession: mock(async () => ({ exitCode: 0, result: "" })),
      generateText: mock(async () => ({ exitCode: 1, text: "" })),
    };
    const item = makeClaimedItem({ title: "fallback title" });

    const msg = await resolveEngineeringCommitMessage(claude, TEST_PROFILE, item, "diff", noop);

    expect(msg).toBe("fallback title");
  });
});

// ---------------------------------------------------------------------------
// resolveValidateOutcomeWithFallback
// ---------------------------------------------------------------------------

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
