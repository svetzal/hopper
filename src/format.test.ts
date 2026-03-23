import { describe, expect, test } from "bun:test";
import { formatDuration, relativeTime, relativeTimeFuture, shortId } from "./format.ts";

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
});
