import { describe, expect, test } from "bun:test";
import { comparePriority, parsePriority, priorityBadge } from "./priority.ts";

describe("parsePriority", () => {
  test("parses full names", () => {
    expect(parsePriority("high")).toEqual({ ok: true, value: "high" });
    expect(parsePriority("normal")).toEqual({ ok: true, value: "normal" });
    expect(parsePriority("low")).toEqual({ ok: true, value: "low" });
  });

  test("parses shorthand values", () => {
    expect(parsePriority("h")).toEqual({ ok: true, value: "high" });
    expect(parsePriority("hi")).toEqual({ ok: true, value: "high" });
    expect(parsePriority("n")).toEqual({ ok: true, value: "normal" });
    expect(parsePriority("l")).toEqual({ ok: true, value: "low" });
    expect(parsePriority("lo")).toEqual({ ok: true, value: "low" });
  });

  test("is case-insensitive", () => {
    expect(parsePriority("HIGH")).toEqual({ ok: true, value: "high" });
    expect(parsePriority("Low")).toEqual({ ok: true, value: "low" });
    expect(parsePriority("Hi")).toEqual({ ok: true, value: "high" });
  });

  test("returns ok: false with error for invalid values", () => {
    expect(parsePriority("urgent")).toEqual({
      ok: false,
      error: "Invalid priority 'urgent'. Use high, normal, or low.",
    });
    expect(parsePriority("x")).toMatchObject({ ok: false });
    expect(parsePriority("")).toMatchObject({ ok: false });
  });
});

describe("priorityBadge", () => {
  test("returns red badge for high", () => {
    expect(priorityBadge("high")).toContain("high");
  });

  test("returns blue badge for low", () => {
    expect(priorityBadge("low")).toContain("low");
  });

  test("returns empty string for normal", () => {
    expect(priorityBadge("normal")).toBe("");
  });

  test("returns empty string for undefined", () => {
    expect(priorityBadge(undefined)).toBe("");
  });
});

describe("comparePriority", () => {
  test("high sorts before normal (returns negative)", () => {
    expect(comparePriority("high", "normal")).toBeLessThan(0);
  });

  test("normal sorts before low (returns negative)", () => {
    expect(comparePriority("normal", "low")).toBeLessThan(0);
  });

  test("high sorts before low (returns negative)", () => {
    expect(comparePriority("high", "low")).toBeLessThan(0);
  });

  test("same priority returns 0", () => {
    expect(comparePriority("high", "high")).toBe(0);
    expect(comparePriority("normal", "normal")).toBe(0);
    expect(comparePriority("low", "low")).toBe(0);
  });

  test("undefined is treated as normal", () => {
    expect(comparePriority(undefined, "normal")).toBe(0);
    expect(comparePriority("normal", undefined)).toBe(0);
    expect(comparePriority(undefined, undefined)).toBe(0);
    expect(comparePriority("high", undefined)).toBeLessThan(0);
    expect(comparePriority(undefined, "low")).toBeLessThan(0);
  });
});
