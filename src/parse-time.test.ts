import { describe, expect, test } from "bun:test";
import { parseDuration, parseTimeSpec } from "./parse-time.ts";

describe("parseTimeSpec", () => {
  // Relative durations
  test("parses seconds: 30s", () => {
    const before = Date.now();
    const result = parseTimeSpec("30s");
    expect(result.ok).toBe(true);
    if (result.ok) {
      const expected = before + 30_000;
      expect(result.value.getTime()).toBeGreaterThanOrEqual(expected - 50);
      expect(result.value.getTime()).toBeLessThanOrEqual(expected + 200);
    }
  });

  test("parses minutes: 5m", () => {
    const before = Date.now();
    const result = parseTimeSpec("5m");
    expect(result.ok).toBe(true);
    if (result.ok) {
      const expected = before + 5 * 60_000;
      expect(result.value.getTime()).toBeGreaterThanOrEqual(expected - 50);
      expect(result.value.getTime()).toBeLessThanOrEqual(expected + 200);
    }
  });

  test("parses hours: 2h", () => {
    const before = Date.now();
    const result = parseTimeSpec("2h");
    expect(result.ok).toBe(true);
    if (result.ok) {
      const expected = before + 2 * 3_600_000;
      expect(result.value.getTime()).toBeGreaterThanOrEqual(expected - 50);
      expect(result.value.getTime()).toBeLessThanOrEqual(expected + 200);
    }
  });

  test("parses days: 1d", () => {
    const before = Date.now();
    const result = parseTimeSpec("1d");
    expect(result.ok).toBe(true);
    if (result.ok) {
      const expected = before + 86_400_000;
      expect(result.value.getTime()).toBeGreaterThanOrEqual(expected - 50);
      expect(result.value.getTime()).toBeLessThanOrEqual(expected + 200);
    }
  });

  test("parses weeks: 1w", () => {
    const before = Date.now();
    const result = parseTimeSpec("1w");
    expect(result.ok).toBe(true);
    if (result.ok) {
      const expected = before + 604_800_000;
      expect(result.value.getTime()).toBeGreaterThanOrEqual(expected - 50);
      expect(result.value.getTime()).toBeLessThanOrEqual(expected + 200);
    }
  });

  test("parses compound duration: 1h30m", () => {
    const before = Date.now();
    const result = parseTimeSpec("1h30m");
    expect(result.ok).toBe(true);
    if (result.ok) {
      const expected = before + 3_600_000 + 30 * 60_000;
      expect(result.value.getTime()).toBeGreaterThanOrEqual(expected - 50);
      expect(result.value.getTime()).toBeLessThanOrEqual(expected + 200);
    }
  });

  test("parses compound duration: 2d12h", () => {
    const before = Date.now();
    const result = parseTimeSpec("2d12h");
    expect(result.ok).toBe(true);
    if (result.ok) {
      const expected = before + 2 * 86_400_000 + 12 * 3_600_000;
      expect(result.value.getTime()).toBeGreaterThanOrEqual(expected - 50);
      expect(result.value.getTime()).toBeLessThanOrEqual(expected + 200);
    }
  });

  test("parses decimal duration: 1.5h", () => {
    const before = Date.now();
    const result = parseTimeSpec("1.5h");
    expect(result.ok).toBe(true);
    if (result.ok) {
      const expected = before + 1.5 * 3_600_000;
      expect(result.value.getTime()).toBeGreaterThanOrEqual(expected - 50);
      expect(result.value.getTime()).toBeLessThanOrEqual(expected + 200);
    }
  });

  test("is case-insensitive for durations", () => {
    const before = Date.now();
    const result = parseTimeSpec("2H");
    expect(result.ok).toBe(true);
    if (result.ok) {
      const expected = before + 2 * 3_600_000;
      expect(result.value.getTime()).toBeGreaterThanOrEqual(expected - 50);
      expect(result.value.getTime()).toBeLessThanOrEqual(expected + 200);
    }
  });

  // Absolute times
  test("parses ISO date (date only → midnight local)", () => {
    const result = parseTimeSpec("2099-12-31");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.getFullYear()).toBe(2099);
      expect(result.value.getMonth()).toBe(11); // December
      expect(result.value.getDate()).toBe(31);
      expect(result.value.getHours()).toBe(0);
    }
  });

  test("parses ISO datetime without timezone (local)", () => {
    const result = parseTimeSpec("2099-06-15T14:00");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.getFullYear()).toBe(2099);
      expect(result.value.getHours()).toBe(14);
      expect(result.value.getMinutes()).toBe(0);
    }
  });

  test("parses full ISO datetime with Z", () => {
    const result = parseTimeSpec("2099-06-15T14:00:00Z");
    expect(result.ok).toBe(true);
    if (result.ok) {
      const expected = new Date("2099-06-15T14:00:00Z");
      expect(result.value.getTime()).toBe(expected.getTime());
    }
  });

  test("parses tomorrow", () => {
    const result = parseTimeSpec("tomorrow");
    expect(result.ok).toBe(true);
    if (result.ok) {
      const expected = new Date();
      expected.setDate(expected.getDate() + 1);
      expected.setHours(0, 0, 0, 0);
      expect(result.value.getTime()).toBe(expected.getTime());
    }
  });

  test("parses tomorrow 9am", () => {
    const result = parseTimeSpec("tomorrow 9am");
    expect(result.ok).toBe(true);
    if (result.ok) {
      const expected = new Date();
      expected.setDate(expected.getDate() + 1);
      expected.setHours(9, 0, 0, 0);
      expect(result.value.getTime()).toBe(expected.getTime());
    }
  });

  test("parses time-only (14:00) — returns future time", () => {
    const result = parseTimeSpec("23:59");
    expect(result.ok).toBe(true);
    if (result.ok) {
      // Should be today or tomorrow at 23:59
      const now = new Date();
      expect(result.value.getTime()).toBeGreaterThan(now.getTime());
      expect(result.value.getHours()).toBe(23);
      expect(result.value.getMinutes()).toBe(59);
    }
  });

  // Validation
  test("returns error on unparseable input", () => {
    const result = parseTimeSpec("not-a-time");
    expect(result).toMatchObject({
      ok: false,
      error: expect.stringContaining("Cannot parse time specification"),
    });
  });

  test("returns error on empty input", () => {
    const result = parseTimeSpec("");
    expect(result).toMatchObject({
      ok: false,
      error: expect.stringContaining("Empty time specification"),
    });
  });

  test("returns error on past absolute date", () => {
    const result = parseTimeSpec("2020-01-01");
    expect(result).toMatchObject({
      ok: false,
      error: expect.stringContaining("Time is in the past"),
    });
  });

  test("parses 2:00pm time-only format", () => {
    const result = parseTimeSpec("2:00pm");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.getHours()).toBe(14);
      expect(result.value.getMinutes()).toBe(0);
      expect(result.value.getTime()).toBeGreaterThan(Date.now());
    }
  });
});

describe("parseDuration", () => {
  test("parses seconds to milliseconds", () => {
    expect(parseDuration("30s")).toEqual({ ok: true, value: 30_000 });
  });

  test("parses minutes to milliseconds", () => {
    expect(parseDuration("5m")).toEqual({ ok: true, value: 300_000 });
  });

  test("parses hours to milliseconds", () => {
    expect(parseDuration("2h")).toEqual({ ok: true, value: 7_200_000 });
  });

  test("parses compound durations", () => {
    expect(parseDuration("1h30m")).toEqual({ ok: true, value: 3_600_000 + 1_800_000 });
  });

  test("parses decimal durations", () => {
    expect(parseDuration("1.5h")).toEqual({ ok: true, value: 5_400_000 });
  });

  test("parses days and weeks", () => {
    expect(parseDuration("1d")).toEqual({ ok: true, value: 86_400_000 });
    expect(parseDuration("1w")).toEqual({ ok: true, value: 604_800_000 });
  });

  test("returns error on non-duration input", () => {
    const result = parseDuration("tomorrow");
    expect(result).toMatchObject({
      ok: false,
      error: expect.stringContaining("Cannot parse duration"),
    });
  });

  test("returns error on absolute time input", () => {
    const result = parseDuration("2099-12-31");
    expect(result).toMatchObject({
      ok: false,
      error: expect.stringContaining("Cannot parse duration"),
    });
  });

  test("is case-insensitive", () => {
    expect(parseDuration("2H")).toEqual({ ok: true, value: 7_200_000 });
  });
});
