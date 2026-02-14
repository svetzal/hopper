import { describe, expect, test } from "bun:test";
import { relativeTime, formatDuration, shortId } from "./format.ts";

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
