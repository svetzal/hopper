import { describe, expect, test } from "bun:test";
import type { ParsedArgs } from "./cli.ts";
import { booleanFlag, stringFlag } from "./command-flags.ts";

function makeParsed(flags: Record<string, string | boolean>): ParsedArgs {
  return { command: "test", positional: [], flags, arrayFlags: {} };
}

describe("command-flags", () => {
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
