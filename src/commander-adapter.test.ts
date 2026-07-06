import { describe, expect, test } from "bun:test";
import { camelToKebab, collect, toParsedArgs } from "./commander-adapter.ts";

describe("camelToKebab", () => {
  test("passes through single-word keys", () => {
    expect(camelToKebab("json")).toBe("json");
    expect(camelToKebab("priority")).toBe("priority");
  });

  test("reverses commander's camelCasing of kebab options", () => {
    expect(camelToKebab("dryRun")).toBe("dry-run");
    expect(camelToKebab("keepWorktree")).toBe("keep-worktree");
    expect(camelToKebab("afterItem")).toBe("after-item");
  });
});

describe("toParsedArgs", () => {
  test("routes scalar and boolean options into flags", () => {
    const parsed = toParsedArgs(["id-1"], { priority: "high", json: true }, "add");
    expect(parsed.positional).toEqual(["id-1"]);
    expect(parsed.flags.priority).toBe("high");
    expect(parsed.flags.json).toBe(true);
    expect(parsed.command).toBe("add");
  });

  test("routes array options into arrayFlags under their kebab name", () => {
    const parsed = toParsedArgs([], { tag: ["a", "b"], afterItem: ["x"] });
    expect(parsed.arrayFlags.tag).toEqual(["a", "b"]);
    expect(parsed.arrayFlags["after-item"]).toEqual(["x"]);
    expect(parsed.flags.tag).toBeUndefined();
  });

  test("drops undefined options so unset flags read as absent", () => {
    const parsed = toParsedArgs([], { priority: undefined, dryRun: true });
    expect("priority" in parsed.flags).toBe(false);
    expect(parsed.flags["dry-run"]).toBe(true);
  });
});

describe("collect", () => {
  test("accumulates repeated values without mutating the previous array", () => {
    const first = collect("a", []);
    const second = collect("b", first);
    expect(first).toEqual(["a"]);
    expect(second).toEqual(["a", "b"]);
  });
});
