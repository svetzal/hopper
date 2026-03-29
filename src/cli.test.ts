import { describe, expect, test } from "bun:test";
import { parseArgs } from "./cli.ts";

describe("parseArgs", () => {
  test("empty args produces command '' with no positional or flags", () => {
    const result = parseArgs([]);
    expect(result.command).toBe("");
    expect(result.positional).toEqual([]);
    expect(result.flags).toEqual({});
    expect(result.arrayFlags).toEqual({});
  });

  test("basic command with positional args", () => {
    const result = parseArgs(["add", "do the thing"]);
    expect(result.command).toBe("add");
    expect(result.positional).toEqual(["do the thing"]);
  });

  test("long flag with value", () => {
    const result = parseArgs(["list", "--priority", "high"]);
    expect(result.command).toBe("list");
    expect(result.flags.priority).toBe("high");
  });

  test("boolean long flag (no following value)", () => {
    const result = parseArgs(["list", "--all"]);
    expect(result.flags.all).toBe(true);
  });

  test("flag followed immediately by another flag is treated as boolean", () => {
    const result = parseArgs(["list", "--all", "--json"]);
    expect(result.flags.all).toBe(true);
    expect(result.flags.json).toBe(true);
  });

  test("short flag alias: -p maps to priority", () => {
    const result = parseArgs(["-p", "high"]);
    expect(result.flags.priority).toBe("high");
  });

  test("long flag alias: --depends-on maps to after-item", () => {
    const result = parseArgs(["add", "desc", "--depends-on", "abc123"]);
    expect(result.flags["after-item"]).toBe("abc123");
  });

  test("repeatable --tag flag accumulates into arrayFlags", () => {
    const result = parseArgs(["add", "desc", "--tag", "a", "--tag", "b"]);
    expect(result.arrayFlags.tag).toEqual(["a", "b"]);
    expect(result.flags.tag).toBe("b");
  });

  test("repeatable --after-item flag accumulates into arrayFlags", () => {
    const result = parseArgs(["add", "desc", "--after-item", "id1", "--after-item", "id2"]);
    expect(result.arrayFlags["after-item"]).toEqual(["id1", "id2"]);
  });

  test("command is first positional, rest go into positional array", () => {
    const result = parseArgs(["tag", "item-id", "tagname"]);
    expect(result.command).toBe("tag");
    expect(result.positional).toEqual(["item-id", "tagname"]);
  });

  test("flags and positionals can be interleaved", () => {
    const result = parseArgs(["add", "--priority", "low", "my task"]);
    expect(result.command).toBe("add");
    expect(result.positional).toEqual(["my task"]);
    expect(result.flags.priority).toBe("low");
  });

  test("unknown short flag without alias is preserved as-is", () => {
    const result = parseArgs(["-x"]);
    expect(result.flags.x).toBe(true);
  });
});
