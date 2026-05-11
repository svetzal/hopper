import { describe, expect, it } from "bun:test";
import { err, isCommandError, ok, unwrapOrError } from "./result";

describe("ok", () => {
  it("returns a success result", () => {
    const r = ok(42);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toBe(42);
  });
});

describe("err", () => {
  it("returns a failure result", () => {
    const r = err("oops");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe("oops");
  });
});

describe("unwrapOrError", () => {
  it("returns the value when result is ok", () => {
    const result = unwrapOrError(ok(42));
    expect(result).toBe(42);
  });

  it("returns a CommandResult error when result is not ok", () => {
    const result = unwrapOrError(err("something went wrong"));
    expect(result).toEqual({ status: "error", message: "something went wrong" });
  });

  it("applies mapper to error when provided", () => {
    const result = unwrapOrError(err({ code: "NOT_FOUND" }), (e) => `Error code: ${e.code}`);
    expect(result).toEqual({ status: "error", message: "Error code: NOT_FOUND" });
  });

  it("returns value unchanged via mapper overload when result is ok", () => {
    const result = unwrapOrError(ok("hello"), (e: string) => `Error: ${e}`);
    expect(result).toBe("hello");
  });
});

describe("isCommandError", () => {
  it("returns true for a CommandResult with status error", () => {
    const candidate = { status: "error", message: "oops" };
    expect(isCommandError(candidate)).toBe(true);
  });

  it("returns false for a CommandResult with status success", () => {
    const candidate = { status: "success", data: {}, humanOutput: "" };
    expect(isCommandError(candidate)).toBe(false);
  });

  it("returns false for a plain string value", () => {
    expect(isCommandError("hello")).toBe(false);
  });

  it("returns false for null", () => {
    expect(isCommandError(null)).toBe(false);
  });

  it("returns false for a plain object without status", () => {
    expect(isCommandError({ message: "oops" })).toBe(false);
  });
});
