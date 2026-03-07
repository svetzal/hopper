import { describe, expect, test } from "bun:test";
import { parseTimeSpec } from "./parse-time.ts";

describe("parseTimeSpec", () => {
  // Relative durations
  test("parses seconds: 30s", () => {
    const before = Date.now();
    const result = parseTimeSpec("30s");
    const expected = before + 30_000;
    expect(result.getTime()).toBeGreaterThanOrEqual(expected - 50);
    expect(result.getTime()).toBeLessThanOrEqual(expected + 200);
  });

  test("parses minutes: 5m", () => {
    const before = Date.now();
    const result = parseTimeSpec("5m");
    const expected = before + 5 * 60_000;
    expect(result.getTime()).toBeGreaterThanOrEqual(expected - 50);
    expect(result.getTime()).toBeLessThanOrEqual(expected + 200);
  });

  test("parses hours: 2h", () => {
    const before = Date.now();
    const result = parseTimeSpec("2h");
    const expected = before + 2 * 3_600_000;
    expect(result.getTime()).toBeGreaterThanOrEqual(expected - 50);
    expect(result.getTime()).toBeLessThanOrEqual(expected + 200);
  });

  test("parses days: 1d", () => {
    const before = Date.now();
    const result = parseTimeSpec("1d");
    const expected = before + 86_400_000;
    expect(result.getTime()).toBeGreaterThanOrEqual(expected - 50);
    expect(result.getTime()).toBeLessThanOrEqual(expected + 200);
  });

  test("parses weeks: 1w", () => {
    const before = Date.now();
    const result = parseTimeSpec("1w");
    const expected = before + 604_800_000;
    expect(result.getTime()).toBeGreaterThanOrEqual(expected - 50);
    expect(result.getTime()).toBeLessThanOrEqual(expected + 200);
  });

  test("parses compound duration: 1h30m", () => {
    const before = Date.now();
    const result = parseTimeSpec("1h30m");
    const expected = before + 3_600_000 + 30 * 60_000;
    expect(result.getTime()).toBeGreaterThanOrEqual(expected - 50);
    expect(result.getTime()).toBeLessThanOrEqual(expected + 200);
  });

  test("parses compound duration: 2d12h", () => {
    const before = Date.now();
    const result = parseTimeSpec("2d12h");
    const expected = before + 2 * 86_400_000 + 12 * 3_600_000;
    expect(result.getTime()).toBeGreaterThanOrEqual(expected - 50);
    expect(result.getTime()).toBeLessThanOrEqual(expected + 200);
  });

  test("parses decimal duration: 1.5h", () => {
    const before = Date.now();
    const result = parseTimeSpec("1.5h");
    const expected = before + 1.5 * 3_600_000;
    expect(result.getTime()).toBeGreaterThanOrEqual(expected - 50);
    expect(result.getTime()).toBeLessThanOrEqual(expected + 200);
  });

  test("is case-insensitive for durations", () => {
    const before = Date.now();
    const result = parseTimeSpec("2H");
    const expected = before + 2 * 3_600_000;
    expect(result.getTime()).toBeGreaterThanOrEqual(expected - 50);
    expect(result.getTime()).toBeLessThanOrEqual(expected + 200);
  });

  // Absolute times
  test("parses ISO date (date only → midnight local)", () => {
    const result = parseTimeSpec("2099-12-31");
    expect(result.getFullYear()).toBe(2099);
    expect(result.getMonth()).toBe(11); // December
    expect(result.getDate()).toBe(31);
    expect(result.getHours()).toBe(0);
  });

  test("parses ISO datetime without timezone (local)", () => {
    const result = parseTimeSpec("2099-06-15T14:00");
    expect(result.getFullYear()).toBe(2099);
    expect(result.getHours()).toBe(14);
    expect(result.getMinutes()).toBe(0);
  });

  test("parses full ISO datetime with Z", () => {
    const result = parseTimeSpec("2099-06-15T14:00:00Z");
    const expected = new Date("2099-06-15T14:00:00Z");
    expect(result.getTime()).toBe(expected.getTime());
  });

  test("parses tomorrow", () => {
    const result = parseTimeSpec("tomorrow");
    const expected = new Date();
    expected.setDate(expected.getDate() + 1);
    expected.setHours(0, 0, 0, 0);
    expect(result.getTime()).toBe(expected.getTime());
  });

  test("parses tomorrow 9am", () => {
    const result = parseTimeSpec("tomorrow 9am");
    const expected = new Date();
    expected.setDate(expected.getDate() + 1);
    expected.setHours(9, 0, 0, 0);
    expect(result.getTime()).toBe(expected.getTime());
  });

  test("parses time-only (14:00) — returns future time", () => {
    const result = parseTimeSpec("23:59");
    // Should be today or tomorrow at 23:59
    const now = new Date();
    expect(result.getTime()).toBeGreaterThan(now.getTime());
    expect(result.getHours()).toBe(23);
    expect(result.getMinutes()).toBe(59);
  });

  // Validation
  test("throws on unparseable input", () => {
    expect(() => parseTimeSpec("not-a-time")).toThrow("Cannot parse time specification");
  });

  test("throws on empty input", () => {
    expect(() => parseTimeSpec("")).toThrow("Empty time specification");
  });

  test("throws on past absolute date", () => {
    expect(() => parseTimeSpec("2020-01-01")).toThrow("Time is in the past");
  });

  test("parses 2:00pm time-only format", () => {
    const result = parseTimeSpec("2:00pm");
    expect(result.getHours()).toBe(14);
    expect(result.getMinutes()).toBe(0);
    expect(result.getTime()).toBeGreaterThan(Date.now());
  });
});
