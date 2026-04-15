import { describe, expect, it } from "bun:test";
import { err, ok } from "./result";

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
