import { describe, expect, test } from "bun:test";
import { parsePriority, priorityBadge } from "./priority.ts";

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
    expect(() => parsePriority("urgent")).toThrow("Invalid priority 'urgent'. Use high, normal, or low.");
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
