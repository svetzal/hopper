import { describe, expect, test } from "bun:test";
import { comparePriority, parsePriority, priorityBadge } from "./priority.ts";

describe("parsePriority", () => {
  test("parses full names", () => {
    expect(parsePriority("high")).toBe("high");
    expect(parsePriority("normal")).toBe("normal");
    expect(parsePriority("low")).toBe("low");
  });

  test("parses shorthand values", () => {
    expect(parsePriority("h")).toBe("high");
    expect(parsePriority("hi")).toBe("high");
    expect(parsePriority("n")).toBe("normal");
    expect(parsePriority("l")).toBe("low");
    expect(parsePriority("lo")).toBe("low");
  });

  test("is case-insensitive", () => {
    expect(parsePriority("HIGH")).toBe("high");
    expect(parsePriority("Low")).toBe("low");
    expect(parsePriority("Hi")).toBe("high");
  });

  test("rejects invalid values", () => {
    expect(() => parsePriority("urgent")).toThrow(
      "Invalid priority 'urgent'. Use high, normal, or low.",
    );
    expect(() => parsePriority("")).toThrow("Invalid priority");
    expect(() => parsePriority("x")).toThrow("Invalid priority");
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
