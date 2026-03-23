import { describe, expect, test } from "bun:test";
import { matchesTags, mergeTags, normalizeTag } from "./tags.ts";

describe("normalizeTag", () => {
  test("lowercases input", () => {
    expect(normalizeTag("MailCtl")).toBe("mailctl");
  });

  test("replaces spaces with hyphens", () => {
    expect(normalizeTag("bug fix")).toBe("bug-fix");
  });

  test("trims whitespace", () => {
    expect(normalizeTag("  hello  ")).toBe("hello");
  });

  test("rejects special characters", () => {
    expect(() => normalizeTag("foo@bar")).toThrow("Invalid tag");
    expect(() => normalizeTag("a.b")).toThrow("Invalid tag");
    expect(() => normalizeTag("tag!")).toThrow("Invalid tag");
  });

  test("rejects empty string", () => {
    expect(() => normalizeTag("")).toThrow("Tag cannot be empty");
    expect(() => normalizeTag("   ")).toThrow("Tag cannot be empty");
  });

  test("rejects tags longer than 32 characters", () => {
    expect(() => normalizeTag("a".repeat(33))).toThrow("32 characters");
  });

  test("allows hyphens and underscores", () => {
    expect(normalizeTag("my-tag_1")).toBe("my-tag_1");
  });
});

describe("mergeTags", () => {
  test("deduplicates and sorts", () => {
    expect(mergeTags(["beta", "alpha"], ["alpha", "gamma"])).toEqual(["alpha", "beta", "gamma"]);
  });

  test("handles empty existing array", () => {
    expect(mergeTags([], ["zebra", "apple"])).toEqual(["apple", "zebra"]);
  });

  test("handles empty additions", () => {
    expect(mergeTags(["a", "b"], [])).toEqual(["a", "b"]);
  });
});

describe("matchesTags", () => {
  test("returns true on any match", () => {
    expect(matchesTags(["alpha", "beta"], ["beta"])).toBe(true);
    expect(matchesTags(["alpha", "beta"], ["gamma", "alpha"])).toBe(true);
  });

  test("returns false on no match", () => {
    expect(matchesTags(["alpha", "beta"], ["gamma"])).toBe(false);
  });

  test("returns false when item has no tags", () => {
    expect(matchesTags(undefined, ["alpha"])).toBe(false);
    expect(matchesTags([], ["alpha"])).toBe(false);
  });
});
