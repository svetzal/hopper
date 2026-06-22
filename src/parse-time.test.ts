import { describe, expect, test } from "bun:test";
import { parseDuration, parseTimeSpec } from "./parse-time.ts";

const NOW = new Date("2026-06-22T12:00:00Z");

describe("parseTimeSpec", () => {
  // Relative durations
  test("parses seconds: 30s", () => {
    const result = parseTimeSpec("30s", NOW);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.getTime()).toBe(NOW.getTime() + 30_000);
    }
  });

  test("parses minutes: 5m", () => {
    const result = parseTimeSpec("5m", NOW);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.getTime()).toBe(NOW.getTime() + 5 * 60_000);
    }
  });

  test("parses hours: 2h", () => {
    const result = parseTimeSpec("2h", NOW);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.getTime()).toBe(NOW.getTime() + 2 * 3_600_000);
    }
  });

  test("parses days: 1d", () => {
    const result = parseTimeSpec("1d", NOW);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.getTime()).toBe(NOW.getTime() + 86_400_000);
    }
  });

  test("parses weeks: 1w", () => {
    const result = parseTimeSpec("1w", NOW);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.getTime()).toBe(NOW.getTime() + 604_800_000);
    }
  });

  test("parses compound duration: 1h30m", () => {
    const result = parseTimeSpec("1h30m", NOW);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.getTime()).toBe(NOW.getTime() + 3_600_000 + 30 * 60_000);
    }
  });

  test("parses compound duration: 2d12h", () => {
    const result = parseTimeSpec("2d12h", NOW);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.getTime()).toBe(NOW.getTime() + 2 * 86_400_000 + 12 * 3_600_000);
    }
  });

  test("parses decimal duration: 1.5h", () => {
    const result = parseTimeSpec("1.5h", NOW);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.getTime()).toBe(NOW.getTime() + 1.5 * 3_600_000);
    }
  });

  test("is case-insensitive for durations", () => {
    const result = parseTimeSpec("2H", NOW);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.getTime()).toBe(NOW.getTime() + 2 * 3_600_000);
    }
  });

  // Absolute times
  test("parses ISO date (date only → midnight local)", () => {
    const result = parseTimeSpec("2099-12-31", NOW);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.getFullYear()).toBe(2099);
      expect(result.value.getMonth()).toBe(11); // December
      expect(result.value.getDate()).toBe(31);
      expect(result.value.getHours()).toBe(0);
    }
  });

  test("parses ISO datetime without timezone (local)", () => {
    const result = parseTimeSpec("2099-06-15T14:00", NOW);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.getFullYear()).toBe(2099);
      expect(result.value.getHours()).toBe(14);
      expect(result.value.getMinutes()).toBe(0);
    }
  });

  test("parses full ISO datetime with Z", () => {
    const result = parseTimeSpec("2099-06-15T14:00:00Z", NOW);
    expect(result.ok).toBe(true);
    if (result.ok) {
      const expected = new Date("2099-06-15T14:00:00Z");
      expect(result.value.getTime()).toBe(expected.getTime());
    }
  });

  test("parses tomorrow", () => {
    const result = parseTimeSpec("tomorrow", NOW);
    expect(result.ok).toBe(true);
    if (result.ok) {
      const expected = new Date(NOW.getTime());
      expected.setDate(expected.getDate() + 1);
      expected.setHours(0, 0, 0, 0);
      expect(result.value.getTime()).toBe(expected.getTime());
    }
  });

  test("parses tomorrow 9am", () => {
    const result = parseTimeSpec("tomorrow 9am", NOW);
    expect(result.ok).toBe(true);
    if (result.ok) {
      const expected = new Date(NOW.getTime());
      expected.setDate(expected.getDate() + 1);
      expected.setHours(9, 0, 0, 0);
      expect(result.value.getTime()).toBe(expected.getTime());
    }
  });

  test("parses time-only (23:59) — returns future time relative to NOW", () => {
    // NOW is 2026-06-22T12:00:00Z; 23:59 local time is in the future today
    const result = parseTimeSpec("23:59", NOW);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.getTime()).toBeGreaterThan(NOW.getTime());
      expect(result.value.getHours()).toBe(23);
      expect(result.value.getMinutes()).toBe(59);
    }
  });

  // Validation
  test("returns error on unparseable input", () => {
    const result = parseTimeSpec("not-a-time", NOW);
    expect(result).toMatchObject({
      ok: false,
      error: expect.stringContaining("Cannot parse time specification"),
    });
  });

  test("returns error on empty input", () => {
    const result = parseTimeSpec("", NOW);
    expect(result).toMatchObject({
      ok: false,
      error: expect.stringContaining("Empty time specification"),
    });
  });

  test("returns error on past absolute date", () => {
    const result = parseTimeSpec("2020-01-01", NOW);
    expect(result).toMatchObject({
      ok: false,
      error: expect.stringContaining("Time is in the past"),
    });
  });

  test("parses 2:00pm time-only format — returns future time relative to NOW", () => {
    // NOW is 2026-06-22T12:00:00Z; 2pm local is in the future
    const result = parseTimeSpec("2:00pm", NOW);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.getHours()).toBe(14);
      expect(result.value.getMinutes()).toBe(0);
      expect(result.value.getTime()).toBeGreaterThan(NOW.getTime());
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
