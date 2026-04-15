import { describe, expect, test } from "bun:test";
import type { ParsedArgs } from "./cli.ts";
import { booleanFlag, requirePositional, stringFlag } from "./command-flags.ts";

function makeParsed(
  flags: Record<string, string | boolean>,
  positional: string[] = [],
): ParsedArgs {
  return { command: "test", positional, flags, arrayFlags: {} };
}

describe("command-flags", () => {
  describe("requirePositional", () => {
    test("returns ok with value when positional exists", () => {
      const parsed = makeParsed({}, ["abc123"]);
      expect(requirePositional(parsed, 0, "Usage: hopper show <id>")).toEqual({
        ok: true,
        value: "abc123",
      });
    });

    test("returns ok: false with error result when positional is missing", () => {
      const parsed = makeParsed({}, []);
      expect(requirePositional(parsed, 0, "Usage: hopper show <id>")).toEqual({
        ok: false,
        error: { status: "error", message: "Usage: hopper show <id>" },
      });
    });

    test("returns the correct positional at the given index", () => {
      const parsed = makeParsed({}, ["first", "second"]);
      expect(requirePositional(parsed, 1, "Usage: hopper reprioritize <id> <level>")).toEqual({
        ok: true,
        value: "second",
      });
    });
  });

  describe("stringFlag", () => {
    test("returns string value when flag is a string", () => {
      const parsed = makeParsed({ agent: "my-agent" });
      expect(stringFlag(parsed, "agent")).toBe("my-agent");
    });

    test("returns undefined when flag is boolean true", () => {
      const parsed = makeParsed({ verbose: true });
      expect(stringFlag(parsed, "verbose")).toBeUndefined();
    });

    test("returns undefined when flag is absent", () => {
      const parsed = makeParsed({});
      expect(stringFlag(parsed, "missing")).toBeUndefined();
    });
  });

  describe("booleanFlag", () => {
    test("returns true when flag is boolean true", () => {
      const parsed = makeParsed({ json: true });
      expect(booleanFlag(parsed, "json")).toBe(true);
    });

    test("returns false when flag is a string", () => {
      const parsed = makeParsed({ json: "yes" });
      expect(booleanFlag(parsed, "json")).toBe(false);
    });

    test("returns false when flag is absent", () => {
      const parsed = makeParsed({});
      expect(booleanFlag(parsed, "json")).toBe(false);
    });
  });
});
