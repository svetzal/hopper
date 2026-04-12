import { describe, expect, test } from "bun:test";
import type { AddValidationError } from "./add-workflow.ts";
import {
  buildNewItem,
  formatValidationError,
  hasCycle,
  MAX_RETRIES,
  resolveDependencies,
  resolveScheduling,
  validateDirBranch,
  validateRetries,
  validateTaskType,
  validateTimesSpec,
} from "./add-workflow.ts";
import type { Item } from "./store.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeItem(overrides?: Partial<Item>): Item {
  return {
    id: "aaaaaaaa-0000-0000-0000-000000000000",
    title: "Test task",
    description: "A test description",
    status: "queued",
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

/** A fixed "now" well into the future so parseTimeSpec won't reject relative specs. */
const NOW = new Date("2030-01-01T00:00:00.000Z");

// ---------------------------------------------------------------------------
// validateDirBranch
// ---------------------------------------------------------------------------

describe("validateDirBranch", () => {
  test("returns null when nothing is set", () => {
    expect(validateDirBranch(undefined, undefined, undefined)).toBeNull();
  });

  test("returns null when dir and branch are both set", () => {
    expect(validateDirBranch("/repo", "main", undefined)).toBeNull();
  });

  test("returns null when dir and command are both set (no branch required)", () => {
    expect(validateDirBranch("/repo", undefined, "make build")).toBeNull();
  });

  test("returns null when all three are set", () => {
    expect(validateDirBranch("/repo", "main", "make build")).toBeNull();
  });

  test("DIR_REQUIRES_BRANCH_OR_COMMAND when dir is set but neither branch nor command", () => {
    expect(validateDirBranch("/repo", undefined, undefined)).toEqual({
      code: "DIR_REQUIRES_BRANCH_OR_COMMAND",
    });
  });

  test("BRANCH_REQUIRES_DIR when branch is set but dir is not", () => {
    expect(validateDirBranch(undefined, "main", undefined)).toEqual({
      code: "BRANCH_REQUIRES_DIR",
    });
  });

  test("investigation type with branch is rejected", () => {
    expect(validateDirBranch("/repo", "feat/x", undefined, "investigation")).toEqual({
      code: "INVESTIGATION_NO_BRANCH",
    });
  });

  test("investigation type with only dir is allowed", () => {
    expect(validateDirBranch("/repo", undefined, undefined, "investigation")).toBeNull();
  });

  test("investigation type with no dir and no branch is allowed", () => {
    expect(validateDirBranch(undefined, undefined, undefined, "investigation")).toBeNull();
  });

  test("engineering type with dir + branch is allowed", () => {
    expect(validateDirBranch("/repo", "main", undefined, "engineering")).toBeNull();
  });

  test("engineering type with dir only is rejected (branch or command required)", () => {
    expect(validateDirBranch("/repo", undefined, undefined, "engineering")).toEqual({
      code: "DIR_REQUIRES_BRANCH_OR_COMMAND",
    });
  });
});

// ---------------------------------------------------------------------------
// validateTaskType
// ---------------------------------------------------------------------------

describe("validateTaskType", () => {
  test("undefined input returns undefined value", () => {
    expect(validateTaskType(undefined)).toEqual({ value: undefined });
  });

  test("accepts investigation", () => {
    expect(validateTaskType("investigation")).toEqual({ value: "investigation" });
  });

  test("accepts engineering", () => {
    expect(validateTaskType("engineering")).toEqual({ value: "engineering" });
  });

  test("accepts task", () => {
    expect(validateTaskType("task")).toEqual({ value: "task" });
  });

  test("rejects unknown type with INVALID_TYPE", () => {
    expect(validateTaskType("spike")).toEqual({
      error: { code: "INVALID_TYPE", value: "spike" },
    });
  });

  test("rejects empty string", () => {
    expect(validateTaskType("")).toEqual({
      error: { code: "INVALID_TYPE", value: "" },
    });
  });
});

// ---------------------------------------------------------------------------
// validateTimesSpec
// ---------------------------------------------------------------------------

describe("validateTimesSpec", () => {
  test("returns undefined value when timesSpec is undefined", () => {
    expect(validateTimesSpec(undefined, undefined)).toEqual({ value: undefined });
    expect(validateTimesSpec(undefined, "1h")).toEqual({ value: undefined });
  });

  test("TIMES_REQUIRES_EVERY when timesSpec is set but everySpec is not", () => {
    expect(validateTimesSpec("3", undefined)).toEqual({
      error: { code: "TIMES_REQUIRES_EVERY" },
    });
  });

  test("returns parsed value when both timesSpec and everySpec are set", () => {
    expect(validateTimesSpec("3", "1h")).toEqual({ value: 3 });
    expect(validateTimesSpec("1", "30m")).toEqual({ value: 1 });
  });

  test("TIMES_INVALID for non-integer string", () => {
    expect(validateTimesSpec("abc", "1h")).toEqual({
      error: { code: "TIMES_INVALID", value: "abc" },
    });
  });

  test("TIMES_INVALID for zero", () => {
    expect(validateTimesSpec("0", "1h")).toEqual({
      error: { code: "TIMES_INVALID", value: "0" },
    });
  });

  test("TIMES_INVALID for negative value", () => {
    expect(validateTimesSpec("-1", "1h")).toEqual({
      error: { code: "TIMES_INVALID", value: "-1" },
    });
  });

  test("decimal value is truncated to integer by parseInt (treated as valid)", () => {
    // parseInt("1.5", 10) === 1, which is a valid positive integer
    expect(validateTimesSpec("1.5", "1h")).toEqual({ value: 1 });
  });
});

// ---------------------------------------------------------------------------
// resolveScheduling
// ---------------------------------------------------------------------------

describe("resolveScheduling", () => {
  test("returns queued status when no specs are given", () => {
    const result = resolveScheduling(undefined, undefined, undefined, undefined, NOW);
    expect(result).toEqual({ status: "queued" });
  });

  test("returns scheduled status with scheduledAt when afterSpec only", () => {
    // Use an absolute ISO date so the result is deterministic
    const after = "2035-06-15T12:00:00Z";
    const result = resolveScheduling(undefined, after, undefined, undefined, NOW);
    expect("error" in result).toBe(false);
    if (!("error" in result)) {
      expect(result.status).toBe("scheduled");
      expect(result.scheduledAt).toBe("2035-06-15T12:00:00.000Z");
      expect(result.recurrence).toBeUndefined();
    }
  });

  test("scheduledAt is approximately now + interval when afterSpec not given", () => {
    const result = resolveScheduling("1h", undefined, undefined, undefined, NOW);
    expect("error" in result).toBe(false);
    if (!("error" in result)) {
      const expected = new Date(NOW.getTime() + 3_600_000).toISOString();
      expect(result.scheduledAt).toBe(expected);
    }
  });

  test("returns recurrence with interval and intervalMs", () => {
    const result = resolveScheduling("1h", undefined, undefined, undefined, NOW);
    expect("error" in result).toBe(false);
    if (!("error" in result)) {
      expect(result.recurrence).toMatchObject({ interval: "1h", intervalMs: 3_600_000 });
    }
  });

  test("recurrence.remainingRuns is timesValue - 1", () => {
    const result = resolveScheduling("1h", undefined, undefined, 3, NOW);
    expect("error" in result).toBe(false);
    if (!("error" in result)) {
      expect(result.recurrence?.remainingRuns).toBe(2);
    }
  });

  test("recurrence.remainingRuns is 0 when timesValue is 1", () => {
    const result = resolveScheduling("1h", undefined, undefined, 1, NOW);
    expect("error" in result).toBe(false);
    if (!("error" in result)) {
      expect(result.recurrence?.remainingRuns).toBe(0);
    }
  });

  test("recurrence has no remainingRuns when timesValue is undefined", () => {
    const result = resolveScheduling("1h", undefined, undefined, undefined, NOW);
    expect("error" in result).toBe(false);
    if (!("error" in result)) {
      expect(result.recurrence?.remainingRuns).toBeUndefined();
    }
  });

  test("EVERY_INVALID when everySpec cannot be parsed as a duration", () => {
    const result = resolveScheduling("notaduration", undefined, undefined, undefined, NOW);
    expect(result).toEqual({ error: { code: "EVERY_INVALID", value: "notaduration" } });
  });

  test("EVERY_TOO_SHORT when interval is less than 5 minutes", () => {
    const result = resolveScheduling("4m", undefined, undefined, undefined, NOW);
    expect(result).toEqual({ error: { code: "EVERY_TOO_SHORT", minimumMinutes: 5 } });
  });

  test("exactly 5 minutes passes the minimum check", () => {
    const result = resolveScheduling("5m", undefined, undefined, undefined, NOW);
    expect("error" in result).toBe(false);
  });

  test("UNTIL_REQUIRES_EVERY when untilSpec is set but everySpec is not", () => {
    const result = resolveScheduling(undefined, undefined, "1d", undefined, NOW);
    expect(result).toEqual({ error: { code: "UNTIL_REQUIRES_EVERY" } });
  });

  test("UNTIL_BEFORE_START when until is before or equal to scheduledAt", () => {
    // scheduledAt = 2035-06-15T12:00 (from afterSpec), until = 2035-06-15T10:00 (before it)
    const result = resolveScheduling(
      "1h",
      "2035-06-15T12:00:00Z",
      "2035-06-15T10:00:00Z",
      undefined,
      NOW,
    );
    expect("error" in result).toBe(true);
    if ("error" in result) {
      expect(result.error.code).toBe("UNTIL_BEFORE_START");
    }
  });

  test("until is stored in recurrence when valid", () => {
    // everySpec=1h, afterSpec=2035-06-15T12:00, untilSpec=2035-12-31T00:00 (after scheduledAt)
    const result = resolveScheduling(
      "1h",
      "2035-06-15T12:00:00Z",
      "2035-12-31T00:00:00Z",
      undefined,
      NOW,
    );
    expect("error" in result).toBe(false);
    if (!("error" in result)) {
      expect(result.recurrence?.until).toBeDefined();
    }
  });

  test("afterSpec (absolute date) is used as scheduledAt for recurring items", () => {
    // Use an absolute ISO date for afterSpec so the result is deterministic
    const result = resolveScheduling("1h", "2035-06-15T12:00:00Z", undefined, undefined, NOW);
    expect("error" in result).toBe(false);
    if (!("error" in result)) {
      expect(result.scheduledAt).toBe("2035-06-15T12:00:00.000Z");
    }
  });
});

// ---------------------------------------------------------------------------
// hasCycle
// ---------------------------------------------------------------------------

describe("hasCycle", () => {
  test("returns false with no items", () => {
    expect(hasCycle(["id-1"], [])).toBe(false);
  });

  test("returns false when dep has no dependencies", () => {
    const items = [makeItem({ id: "id-1" })];
    expect(hasCycle(["id-1"], items)).toBe(false);
  });

  test("returns false when dep chain does not cycle back", () => {
    const items = [
      makeItem({ id: "id-1", dependsOn: ["id-2"] }),
      makeItem({ id: "id-2", dependsOn: ["id-3"] }),
      makeItem({ id: "id-3" }),
    ];
    expect(hasCycle(["id-1"], items)).toBe(false);
  });

  test("returns true when a dep's dependency points back to another dep in the set", () => {
    // id-1 depends on id-2; id-2 depends on id-1 → cycle
    const items = [
      makeItem({ id: "id-1", dependsOn: ["id-2"] }),
      makeItem({ id: "id-2", dependsOn: ["id-1"] }),
    ];
    expect(hasCycle(["id-1", "id-2"], items)).toBe(true);
  });

  test("returns false with a single self-referential dep not in set", () => {
    // id-2 depends on id-3 which is not in depIds → no cycle
    const items = [
      makeItem({ id: "id-1" }),
      makeItem({ id: "id-2", dependsOn: ["id-3"] }),
      makeItem({ id: "id-3" }),
    ];
    expect(hasCycle(["id-1", "id-2"], items)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// resolveDependencies
// ---------------------------------------------------------------------------

describe("resolveDependencies", () => {
  const items = [
    makeItem({ id: "aaaaaaaa-1111-0000-0000-000000000000", status: "queued" }),
    makeItem({ id: "bbbbbbbb-2222-0000-0000-000000000000", status: "completed" }),
    makeItem({ id: "cccccccc-3333-0000-0000-000000000000", status: "queued" }),
  ];

  test("resolves exact full IDs", () => {
    const result = resolveDependencies(["aaaaaaaa-1111-0000-0000-000000000000"], items);
    expect(result).toEqual({
      ok: true,
      resolvedIds: ["aaaaaaaa-1111-0000-0000-000000000000"],
      warnings: [],
    });
  });

  test("resolves ID prefixes", () => {
    const result = resolveDependencies(["aaaaaaaa"], items);
    expect(result).toMatchObject({
      ok: true,
      resolvedIds: ["aaaaaaaa-1111-0000-0000-000000000000"],
    });
  });

  test("DEP_NOT_FOUND when prefix matches no items", () => {
    const result = resolveDependencies(["zzzzzzzz"], items);
    expect(result).toEqual({ ok: false, error: { code: "DEP_NOT_FOUND", idPrefix: "zzzzzzzz" } });
  });

  test("DEP_AMBIGUOUS when prefix matches multiple items", () => {
    // Both aaaa… and bbbb… share nothing in common, but we need two items with same prefix
    const ambigItems = [
      makeItem({ id: "aaaa1111-0000-0000-0000-000000000000" }),
      makeItem({ id: "aaaa2222-0000-0000-0000-000000000000" }),
    ];
    const result = resolveDependencies(["aaaa"], ambigItems);
    expect(result).toEqual({
      ok: false,
      error: { code: "DEP_AMBIGUOUS", idPrefix: "aaaa", matchCount: 2 },
    });
  });

  test("adds warning when dependency is already completed", () => {
    const result = resolveDependencies(["bbbbbbbb"], items);
    expect(result).toMatchObject({ ok: true });
    if (result.ok) {
      expect(result.warnings).toHaveLength(1);
      expect(result.warnings[0]).toContain("already completed");
    }
  });

  test("no warning for non-completed dependencies", () => {
    const result = resolveDependencies(["aaaaaaaa"], items);
    expect(result).toMatchObject({ ok: true });
    if (result.ok) {
      expect(result.warnings).toHaveLength(0);
    }
  });

  test("CIRCULAR_DEPENDENCY when cycle detected", () => {
    const cycleItems = [
      makeItem({
        id: "id-alpha-0000-0000-0000-000000000000",
        dependsOn: ["id-beta-0000-0000-0000-000000000000"],
      }),
      makeItem({
        id: "id-beta-0000-0000-0000-000000000000",
        dependsOn: ["id-alpha-0000-0000-0000-000000000000"],
      }),
    ];
    const result = resolveDependencies(
      ["id-alpha-0000-0000-0000-000000000000", "id-beta-0000-0000-0000-000000000000"],
      cycleItems,
    );
    expect(result).toEqual({ ok: false, error: { code: "CIRCULAR_DEPENDENCY" } });
  });

  test("handles empty prefix list", () => {
    const result = resolveDependencies([], items);
    expect(result).toEqual({ ok: true, resolvedIds: [], warnings: [] });
  });
});

// ---------------------------------------------------------------------------
// buildNewItem
// ---------------------------------------------------------------------------

describe("buildNewItem", () => {
  const BASE = {
    id: "test-uuid-0000-0000-0000-000000000000",
    title: "Test title",
    description: "Test description",
    status: "queued",
    createdAt: "2030-01-01T00:00:00.000Z",
  };

  test("returns item with required fields", () => {
    const item = buildNewItem(BASE);
    expect(item.id).toBe(BASE.id);
    expect(item.title).toBe(BASE.title);
    expect(item.description).toBe(BASE.description);
    expect(item.status).toBe("queued");
    expect(item.createdAt).toBe(BASE.createdAt);
  });

  test("omits priority field when undefined", () => {
    const item = buildNewItem(BASE);
    expect(item.priority).toBeUndefined();
  });

  test("omits priority field when 'normal' (keeps item lean)", () => {
    const item = buildNewItem({ ...BASE, priority: "normal" });
    expect(item.priority).toBeUndefined();
  });

  test("sets priority for 'high'", () => {
    const item = buildNewItem({ ...BASE, priority: "high" });
    expect(item.priority).toBe("high");
  });

  test("sets priority for 'low'", () => {
    const item = buildNewItem({ ...BASE, priority: "low" });
    expect(item.priority).toBe("low");
  });

  test("sets workingDir from dir param", () => {
    const item = buildNewItem({ ...BASE, dir: "/some/path" });
    expect(item.workingDir).toBe("/some/path");
  });

  test("sets branch when provided", () => {
    const item = buildNewItem({ ...BASE, dir: "/repo", branch: "main" });
    expect(item.branch).toBe("main");
  });

  test("sets command when provided", () => {
    const item = buildNewItem({ ...BASE, command: "make build" });
    expect(item.command).toBe("make build");
  });

  test("sets scheduledAt when provided", () => {
    const item = buildNewItem({ ...BASE, scheduledAt: "2030-06-01T00:00:00.000Z" });
    expect(item.scheduledAt).toBe("2030-06-01T00:00:00.000Z");
  });

  test("sets recurrence when provided", () => {
    const recurrence = { interval: "1h", intervalMs: 3_600_000 };
    const item = buildNewItem({ ...BASE, recurrence });
    expect(item.recurrence).toEqual(recurrence);
  });

  test("sets dependsOn when provided", () => {
    const item = buildNewItem({ ...BASE, dependsOn: ["dep-id-1", "dep-id-2"] });
    expect(item.dependsOn).toEqual(["dep-id-1", "dep-id-2"]);
  });

  test("sets tags when provided", () => {
    const item = buildNewItem({ ...BASE, tags: ["alpha", "beta"] });
    expect(item.tags).toEqual(["alpha", "beta"]);
  });

  test("omits tags field when empty array", () => {
    const item = buildNewItem({ ...BASE, tags: [] });
    expect(item.tags).toBeUndefined();
  });

  test("omits optional fields when not provided", () => {
    const item = buildNewItem(BASE);
    expect(item.scheduledAt).toBeUndefined();
    expect(item.workingDir).toBeUndefined();
    expect(item.branch).toBeUndefined();
    expect(item.command).toBeUndefined();
    expect(item.recurrence).toBeUndefined();
    expect(item.dependsOn).toBeUndefined();
    expect(item.tags).toBeUndefined();
    expect(item.type).toBeUndefined();
    expect(item.agent).toBeUndefined();
  });

  test("sets type when provided", () => {
    const item = buildNewItem({ ...BASE, type: "engineering" });
    expect(item.type).toBe("engineering");
  });

  test("sets agent when provided", () => {
    const item = buildNewItem({ ...BASE, agent: "rust-craftsperson" });
    expect(item.agent).toBe("rust-craftsperson");
  });
});

// ---------------------------------------------------------------------------
// formatValidationError
// ---------------------------------------------------------------------------

describe("formatValidationError", () => {
  const cases: Array<[AddValidationError, string]> = [
    [{ code: "MISSING_DESCRIPTION" }, "Usage: hopper add <description>"],
    [{ code: "BRANCH_REQUIRES_DIR" }, "--branch requires --dir"],
    [{ code: "DIR_REQUIRES_BRANCH_OR_COMMAND" }, "--branch is required when --dir is set"],
    [{ code: "TIMES_REQUIRES_EVERY" }, "--times requires --every"],
    [{ code: "TIMES_INVALID", value: "abc" }, "--times must be a positive integer"],
    [{ code: "UNTIL_REQUIRES_EVERY" }, "--until requires --every"],
    [{ code: "EVERY_INVALID", value: "xyz" }, 'got "xyz"'],
    [{ code: "EVERY_TOO_SHORT", minimumMinutes: 5 }, "5 minutes"],
    [
      { code: "UNTIL_BEFORE_START", until: "1h", start: "2h" },
      "--until must be after the scheduled start time",
    ],
    [{ code: "CIRCULAR_DEPENDENCY" }, "Circular dependency"],
    [{ code: "DEP_NOT_FOUND", idPrefix: "abc123" }, "abc123"],
    [{ code: "DEP_AMBIGUOUS", idPrefix: "abc", matchCount: 3 }, "3 items"],
    [{ code: "INVALID_TYPE", value: "spike" }, "spike"],
    [{ code: "INVESTIGATION_NO_BRANCH" }, "investigation items cannot have --branch"],
  ];

  for (const [error, expectedSubstring] of cases) {
    test(`${error.code} message contains "${expectedSubstring}"`, () => {
      expect(formatValidationError(error)).toContain(expectedSubstring);
    });
  }
});

describe("validateRetries", () => {
  test("accepts undefined (no flag provided)", () => {
    expect(validateRetries(undefined)).toEqual({ value: undefined });
  });

  test("accepts 0 (explicitly opt out of any retries)", () => {
    expect(validateRetries("0")).toEqual({ value: 0 });
  });

  test("accepts the max cap value", () => {
    expect(validateRetries(String(MAX_RETRIES))).toEqual({ value: MAX_RETRIES });
  });

  test("rejects negative integers", () => {
    expect(validateRetries("-1")).toEqual({
      error: { code: "RETRIES_INVALID", value: "-1" },
    });
  });

  test("rejects non-numeric input", () => {
    expect(validateRetries("lots")).toEqual({
      error: { code: "RETRIES_INVALID", value: "lots" },
    });
  });

  test("rejects decimals", () => {
    expect(validateRetries("1.5")).toEqual({
      error: { code: "RETRIES_INVALID", value: "1.5" },
    });
  });

  test("rejects values above the cap", () => {
    const above = MAX_RETRIES + 1;
    expect(validateRetries(String(above))).toEqual({
      error: { code: "RETRIES_TOO_HIGH", value: above, max: MAX_RETRIES },
    });
  });

  test("formatValidationError renders a readable message for RETRIES_INVALID", () => {
    expect(formatValidationError({ code: "RETRIES_INVALID", value: "lots" })).toContain(
      "non-negative integer",
    );
  });

  test("formatValidationError renders a readable message for RETRIES_TOO_HIGH", () => {
    expect(
      formatValidationError({ code: "RETRIES_TOO_HIGH", value: 10, max: MAX_RETRIES }),
    ).toContain(`capped at ${MAX_RETRIES}`);
  });
});
