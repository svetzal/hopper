import { describe, expect, it } from "bun:test";
import { toErrorMessage } from "./error-utils";

describe("toErrorMessage", () => {
  it("returns message from an Error", () => {
    expect(toErrorMessage(new Error("boom"))).toBe("boom");
  });

  it("converts a string", () => {
    expect(toErrorMessage("something went wrong")).toBe("something went wrong");
  });

  it("converts null", () => {
    expect(toErrorMessage(null)).toBe("null");
  });

  it("converts undefined", () => {
    expect(toErrorMessage(undefined)).toBe("undefined");
  });

  it("converts a number", () => {
    expect(toErrorMessage(42)).toBe("42");
  });
});
