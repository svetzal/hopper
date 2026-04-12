import { describe, expect, test } from "bun:test";
import {
  formatDuration,
  formatItemDetail,
  formatPhasesStatus,
  relativeTime,
  relativeTimeFuture,
  shortId,
} from "./format.ts";
import type { Item, PhaseRecord } from "./store.ts";

function makeItem(overrides?: Partial<Item>): Item {
  return {
    id: "abcdef12-3456-7890-abcd-ef1234567890",
    title: "Test item",
    description: "A test description",
    status: "queued",
    createdAt: "2025-01-01T10:00:00Z",
    ...overrides,
  };
}

describe("formatPhasesStatus", () => {
  function mkPhase(overrides: Partial<PhaseRecord> & { name: PhaseRecord["name"] }): PhaseRecord {
    return {
      startedAt: "2026-04-12T10:00:00Z",
      endedAt: "2026-04-12T10:00:30Z",
      exitCode: 0,
      ...overrides,
    };
  }

  test("returns empty string when phases is undefined or empty", () => {
    expect(formatPhasesStatus(undefined)).toBe("");
    expect(formatPhasesStatus([])).toBe("");
  });

  test("renders a single completed plan phase with check mark", () => {
    const result = formatPhasesStatus([
      mkPhase({
        name: "plan",
        startedAt: "2026-04-12T10:00:00Z",
        endedAt: "2026-04-12T10:34:00Z",
      }),
    ]);
    expect(result).toContain("plan ✓");
    expect(result).toContain("34m");
  });

  test("renders all three phases in canonical order (plan → execute → validate) even when stored out of order", () => {
    const result = formatPhasesStatus([
      mkPhase({
        name: "validate",
        startedAt: "2026-04-12T11:00:00Z",
        endedAt: "2026-04-12T11:00:10Z",
        passed: true,
      }),
      mkPhase({ name: "plan" }),
      mkPhase({ name: "execute" }),
    ]);
    const planIdx = result.indexOf("plan ");
    const execIdx = result.indexOf("execute ");
    const validIdx = result.indexOf("validate ");
    expect(planIdx).toBeGreaterThan(-1);
    expect(execIdx).toBeGreaterThan(planIdx);
    expect(validIdx).toBeGreaterThan(execIdx);
  });

  test("uses slash separators between phases", () => {
    const result = formatPhasesStatus([mkPhase({ name: "plan" }), mkPhase({ name: "execute" })]);
    expect(result).toContain(" / ");
  });

  test("renders a failing execute phase with a cross mark", () => {
    const result = formatPhasesStatus([
      mkPhase({ name: "plan" }),
      mkPhase({ name: "execute", exitCode: 2 }),
    ]);
    expect(result).toContain("execute ✗");
  });

  test("validate uses passed flag, not exitCode, for success", () => {
    // exit 0 but passed: false → still ✗ FAIL (missing marker / validate FAIL)
    const result = formatPhasesStatus([mkPhase({ name: "validate", exitCode: 0, passed: false })]);
    expect(result).toContain("validate ✗");
    expect(result).toContain("FAIL");
  });

  test("validate PASS renders with check mark and no FAIL suffix", () => {
    const result = formatPhasesStatus([mkPhase({ name: "validate", exitCode: 0, passed: true })]);
    expect(result).toContain("validate ✓");
    expect(result).not.toContain("FAIL");
  });

  test("sub-minute durations render as <1m to avoid misleading '0m'", () => {
    const result = formatPhasesStatus([
      mkPhase({
        name: "plan",
        startedAt: "2026-04-12T10:00:00Z",
        endedAt: "2026-04-12T10:00:15Z",
      }),
    ]);
    expect(result).toContain("<1m");
    expect(result).not.toContain("0m");
  });

  test("does not render phases that are not in the canonical set", () => {
    // Defensive: if a bogus phase name sneaks in, it is silently dropped
    // rather than breaking rendering.
    const bogus = { ...mkPhase({ name: "plan" }), name: "unknown" } as unknown as PhaseRecord;
    const result = formatPhasesStatus([bogus]);
    expect(result).toBe("");
  });

  test("renders multiple attempts in temporal order (attempt, then name)", () => {
    const phases: PhaseRecord[] = [
      mkPhase({ name: "plan", attempt: 1 }),
      mkPhase({ name: "execute", attempt: 1 }),
      mkPhase({ name: "validate", attempt: 1, passed: false }),
      mkPhase({ name: "execute", attempt: 2 }),
      mkPhase({ name: "validate", attempt: 2, passed: true }),
    ];
    const result = formatPhasesStatus(phases);
    const segments = result.split(" / ");
    expect(segments[0]).toContain("plan ✓");
    expect(segments[1]).toContain("execute ✓");
    expect(segments[2]).toContain("validate ✗");
    expect(segments[2]).toContain("FAIL");
    expect(segments[3]).toContain("execute ✓");
    expect(segments[4]).toContain("validate ✓");
  });

  test("retry output even with scrambled input order renders attempts ascending", () => {
    const phases: PhaseRecord[] = [
      mkPhase({ name: "validate", attempt: 2, passed: true }),
      mkPhase({ name: "execute", attempt: 2 }),
      mkPhase({ name: "validate", attempt: 1, passed: false }),
      mkPhase({ name: "execute", attempt: 1 }),
      mkPhase({ name: "plan", attempt: 1 }),
    ];
    const result = formatPhasesStatus(phases);
    const segments = result.split(" / ");
    expect(segments).toHaveLength(5);
    // First segment is plan, last is the attempt-2 validate PASS
    expect(segments[0]?.startsWith("plan")).toBe(true);
    expect(segments[segments.length - 1]?.startsWith("validate ✓")).toBe(true);
  });
});

describe("formatItemDetail — engineering audit paths", () => {
  test("engineering items show all four per-phase audit paths", () => {
    const output = formatItemDetail(
      makeItem({ type: "engineering", workingDir: "/repo", branch: "main" }),
    );
    expect(output).toContain(
      "Plan file:    ~/.hopper/audit/abcdef12-3456-7890-abcd-ef1234567890-plan.md",
    );
    expect(output).toContain(
      "Plan audit:   ~/.hopper/audit/abcdef12-3456-7890-abcd-ef1234567890-plan.jsonl",
    );
    expect(output).toContain(
      "Exec audit:   ~/.hopper/audit/abcdef12-3456-7890-abcd-ef1234567890-execute.jsonl",
    );
    expect(output).toContain(
      "Valid audit:  ~/.hopper/audit/abcdef12-3456-7890-abcd-ef1234567890-validate.jsonl",
    );
  });

  test("non-engineering items do not list engineering audit paths", () => {
    const taskOutput = formatItemDetail(makeItem());
    expect(taskOutput).not.toContain("-plan.md");
    expect(taskOutput).not.toContain("-plan.jsonl");
    expect(taskOutput).not.toContain("-execute.jsonl");
    expect(taskOutput).not.toContain("-validate.jsonl");
  });

  test("investigation items do not list engineering audit paths", () => {
    const invOutput = formatItemDetail(makeItem({ type: "investigation" }));
    expect(invOutput).not.toContain("-plan.jsonl");
    expect(invOutput).not.toContain("-execute.jsonl");
    expect(invOutput).not.toContain("-validate.jsonl");
  });

  test("engineering item with phases shows a Phases: status strip above the audit paths", () => {
    const output = formatItemDetail(
      makeItem({
        type: "engineering",
        workingDir: "/repo",
        branch: "main",
        phases: [
          {
            name: "plan",
            startedAt: "2026-04-12T10:00:00Z",
            endedAt: "2026-04-12T10:00:30Z",
            exitCode: 0,
          },
          {
            name: "execute",
            startedAt: "2026-04-12T10:01:00Z",
            endedAt: "2026-04-12T10:03:11Z",
            exitCode: 0,
          },
        ],
      }),
    );
    const phasesLineIdx = output.indexOf("Phases:");
    const planFileIdx = output.indexOf("Plan file:");
    expect(phasesLineIdx).toBeGreaterThan(-1);
    expect(phasesLineIdx).toBeLessThan(planFileIdx);
    expect(output).toContain("plan ✓");
    expect(output).toContain("execute ✓");
  });

  test("engineering item without phases omits the Phases: line but still shows audit paths", () => {
    const output = formatItemDetail(
      makeItem({ type: "engineering", workingDir: "/repo", branch: "main" }),
    );
    expect(output).not.toContain("Phases:");
    expect(output).toContain("Plan file:");
  });

  test("engineering item still shows Type and Agent labels above the audit block", () => {
    const output = formatItemDetail(
      makeItem({
        type: "engineering",
        agent: "typescript-bun-cli-craftsperson",
        workingDir: "/repo",
        branch: "main",
      }),
    );
    const typeIdx = output.indexOf("Type:");
    const agentIdx = output.indexOf("Agent:");
    const planFileIdx = output.indexOf("Plan file:");
    expect(typeIdx).toBeGreaterThan(-1);
    expect(agentIdx).toBeGreaterThan(-1);
    expect(planFileIdx).toBeGreaterThan(-1);
    expect(typeIdx).toBeLessThan(planFileIdx);
    expect(agentIdx).toBeLessThan(planFileIdx);
  });
});

describe("format", () => {
  describe("relativeTime", () => {
    test("returns 'just now' for recent timestamps", () => {
      const now = new Date().toISOString();
      expect(relativeTime(now)).toBe("just now");
    });

    test("returns minutes ago", () => {
      const fiveMinAgo = new Date(Date.now() - 5 * 60 * 1000).toISOString();
      expect(relativeTime(fiveMinAgo)).toBe("5m ago");
    });

    test("returns hours ago", () => {
      const threeHoursAgo = new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString();
      expect(relativeTime(threeHoursAgo)).toBe("3h ago");
    });

    test("returns days ago", () => {
      const twoDaysAgo = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString();
      expect(relativeTime(twoDaysAgo)).toBe("2d ago");
    });
  });

  describe("relativeTimeFuture", () => {
    test("returns 'now' for timestamps in the past", () => {
      const oneSecondAgo = new Date(Date.now() - 1000).toISOString();
      expect(relativeTimeFuture(oneSecondAgo)).toBe("now");
    });

    test("returns 'now' for the current timestamp", () => {
      const now = new Date(Date.now()).toISOString();
      expect(relativeTimeFuture(now)).toBe("now");
    });

    test("returns seconds for near-future timestamps", () => {
      const thirtySecondsAhead = new Date(Date.now() + 30 * 1000).toISOString();
      expect(relativeTimeFuture(thirtySecondsAhead)).toBe("in 30s");
    });

    test("returns minutes for future timestamps under an hour", () => {
      const fiveMinutesAhead = new Date(Date.now() + 5 * 60 * 1000).toISOString();
      expect(relativeTimeFuture(fiveMinutesAhead)).toBe("in 5m");
    });

    test("returns hours for future timestamps under a day", () => {
      const threeHoursAhead = new Date(Date.now() + 3 * 60 * 60 * 1000).toISOString();
      expect(relativeTimeFuture(threeHoursAhead)).toBe("in 3h");
    });

    test("returns days for future timestamps over a day", () => {
      const twoDaysAhead = new Date(Date.now() + 2 * 24 * 60 * 60 * 1000).toISOString();
      expect(relativeTimeFuture(twoDaysAhead)).toBe("in 2d");
    });
  });

  describe("formatDuration", () => {
    test("formats minutes only", () => {
      const start = "2025-01-01T10:00:00Z";
      const end = "2025-01-01T10:45:00Z";
      expect(formatDuration(start, end)).toBe("45m");
    });

    test("formats hours and minutes", () => {
      const start = "2025-01-01T10:00:00Z";
      const end = "2025-01-01T12:30:00Z";
      expect(formatDuration(start, end)).toBe("2h 30m");
    });

    test("formats exact hours", () => {
      const start = "2025-01-01T10:00:00Z";
      const end = "2025-01-01T13:00:00Z";
      expect(formatDuration(start, end)).toBe("3h");
    });
  });

  describe("shortId", () => {
    test("truncates to first 8 characters", () => {
      expect(shortId("abcdef12-3456-7890-abcd-ef1234567890")).toBe("abcdef12");
    });

    test("handles short strings", () => {
      expect(shortId("abc")).toBe("abc");
    });
  });

  describe("formatItemDetail", () => {
    test("includes ID, title, status, and created date", () => {
      const item = makeItem();
      const output = formatItemDetail(item);

      expect(output).toContain("ID:");
      expect(output).toContain("abcdef12");
      expect(output).toContain("Title:");
      expect(output).toContain("Test item");
      expect(output).toContain("Status:");
      expect(output).toContain("queued");
      expect(output).toContain("Created:");
    });

    test("includes description section", () => {
      const item = makeItem({ description: "Do the thing" });
      const output = formatItemDetail(item);

      expect(output).toContain("Description:");
      expect(output).toContain("Do the thing");
    });

    test("includes optional claimed fields when present", () => {
      const item = makeItem({
        status: "in_progress",
        claimedAt: "2025-01-01T11:00:00Z",
        claimedBy: "bot",
      });
      const output = formatItemDetail(item);

      expect(output).toContain("Claimed:");
      expect(output).toContain("Claimed by:");
      expect(output).toContain("bot");
    });

    test("includes result section when present", () => {
      const item = makeItem({ result: "All tasks done." });
      const output = formatItemDetail(item);

      expect(output).toContain("Result:");
      expect(output).toContain("All tasks done.");
    });

    test("includes tags when present", () => {
      const item = makeItem({ tags: ["frontend", "backend"] });
      const output = formatItemDetail(item);

      expect(output).toContain("Tags:");
      expect(output).toContain("frontend, backend");
    });

    test("includes recurrence details when present", () => {
      const item = makeItem({
        recurrence: { interval: "1d", intervalMs: 86400000, remainingRuns: 3 },
      });
      const output = formatItemDetail(item);

      expect(output).toContain("Recurrence:");
      expect(output).toContain("every 1d");
      expect(output).toContain("3 runs remaining");
    });

    test("omits optional fields when not present", () => {
      const item = makeItem();
      const output = formatItemDetail(item);

      expect(output).not.toContain("Claimed:");
      expect(output).not.toContain("Tags:");
      expect(output).not.toContain("Result:");
      expect(output).not.toContain("Type:");
      expect(output).not.toContain("Agent:");
    });

    test("includes type when present", () => {
      const item = makeItem({ type: "engineering" });
      const output = formatItemDetail(item);

      expect(output).toContain("Type:");
      expect(output).toContain("engineering");
    });

    test("includes agent when present", () => {
      const item = makeItem({ agent: "rust-craftsperson" });
      const output = formatItemDetail(item);

      expect(output).toContain("Agent:");
      expect(output).toContain("rust-craftsperson");
    });
  });
});
