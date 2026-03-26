import { describe, expect, test } from "bun:test";
import {
  formatDuration,
  formatItemDetail,
  relativeTime,
  relativeTimeFuture,
  shortId,
} from "./format.ts";
import type { Item } from "./store.ts";

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
    });
  });
});
