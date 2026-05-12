import { describe, expect, it } from "bun:test";
import { unwrapPositional } from "./command-flags.ts";
import {
  CommandErrorSignal,
  catchCommandError,
  err,
  isCommandError,
  ok,
  unwrap,
  unwrapOrError,
} from "./result";
import { makeParsed } from "./test-helpers.ts";

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

describe("unwrap", () => {
  it("returns the value when result is ok", () => {
    expect(unwrap(ok(42))).toBe(42);
  });

  it("throws CommandErrorSignal when result is not ok", () => {
    expect(() => unwrap(err("boom"))).toThrow(CommandErrorSignal);
  });

  it("thrown signal carries the error message", () => {
    try {
      unwrap(err("bad input"));
      expect(true).toBe(false); // should not reach here
    } catch (e) {
      expect(e).toBeInstanceOf(CommandErrorSignal);
      if (e instanceof CommandErrorSignal) {
        expect(e.result).toEqual({ status: "error", message: "bad input" });
      }
    }
  });

  it("applies mapper to error when provided", () => {
    expect(() => unwrap(err({ code: "NOT_FOUND" }), (e) => `Error: ${e.code}`)).toThrow(
      CommandErrorSignal,
    );
    try {
      unwrap(err({ code: "NOT_FOUND" }), (e) => `Error: ${e.code}`);
    } catch (e) {
      if (e instanceof CommandErrorSignal) {
        expect(e.result.message).toBe("Error: NOT_FOUND");
      }
    }
  });
});

describe("catchCommandError", () => {
  it("returns the command result on success", async () => {
    const result = await catchCommandError(async () => ({
      status: "success" as const,
      data: 42,
      humanOutput: "ok",
    }));
    expect(result).toEqual({ status: "success", data: 42, humanOutput: "ok" });
  });

  it("catches CommandErrorSignal and returns its payload", async () => {
    const result = await catchCommandError(async () => {
      unwrap(err("something failed"));
      return { status: "success" as const, data: null, humanOutput: "" };
    });
    expect(result).toEqual({ status: "error", message: "something failed" });
  });

  it("re-throws non-signal errors", async () => {
    await expect(
      catchCommandError(async () => {
        throw new Error("unexpected");
      }),
    ).rejects.toThrow("unexpected");
  });
});

describe("unwrapPositional", () => {
  it("returns the positional value when present", () => {
    const parsed = makeParsed("cmd", ["hello"]);
    expect(unwrapPositional(parsed, 0, "Usage: cmd <arg>")).toBe("hello");
  });

  it("throws CommandErrorSignal with usage message when missing", () => {
    const parsed = makeParsed("cmd", []);
    expect(() => unwrapPositional(parsed, 0, "Usage: cmd <arg>")).toThrow(CommandErrorSignal);
    try {
      unwrapPositional(parsed, 0, "Usage: cmd <arg>");
    } catch (e) {
      if (e instanceof CommandErrorSignal) {
        expect(e.result.message).toBe("Usage: cmd <arg>");
      }
    }
  });
});
