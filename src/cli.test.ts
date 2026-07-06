import { describe, expect, test } from "bun:test";
import type { Command } from "commander";
import { buildProgram, type CliDeps, defaultDeps, type ParsedArgs } from "./cli.ts";
import type { CommandResult } from "./command-result.ts";
import { VERSION } from "./constants.ts";

/**
 * Build a program whose command bodies are spies. Each records the ParsedArgs
 * it was handed, so we can assert commander's parse behaviour (aliases,
 * repeatables, positionals, unknown-flag rejection) without running any I/O.
 */
function spyProgram() {
  const calls: Record<string, ParsedArgs[]> = {};
  const push = (name: string, parsed: ParsedArgs) => {
    const list = calls[name] ?? [];
    list.push(parsed);
    calls[name] = list;
  };
  const record =
    (name: string) =>
    (parsed: ParsedArgs): Promise<CommandResult> => {
      push(name, parsed);
      return Promise.resolve({ status: "success", data: null, humanOutput: "" });
    };

  // Uniform spies over heterogeneous command signatures — collected as unknown,
  // then cast to the deps contract once (the spies only ever read parsed[0]).
  const spies: Record<string, unknown> = {};
  for (const key of Object.keys(defaultDeps)) {
    spies[key] = record(key.replace(/Command$/, ""));
  }
  spies.workerCommand = (parsed: ParsedArgs) => {
    push("worker", parsed);
    return Promise.resolve();
  };
  const deps = spies as unknown as CliDeps;

  const out: string[] = [];
  const err: string[] = [];
  const program = buildProgram(deps);

  // exitOverride + configureOutput must reach every (sub)command so a parse
  // error throws (and is captured) instead of calling the real process.exit.
  const wire = (cmd: Command) => {
    cmd.exitOverride().configureOutput({
      writeOut: (s) => out.push(s),
      writeErr: (s) => err.push(s),
    });
    for (const sub of cmd.commands) wire(sub);
  };
  wire(program);

  const run = (argv: string[]) => program.parseAsync(argv, { from: "user" });
  return { run, calls, out: () => out.join(""), err: () => err.join("") };
}

describe("hopper CLI parsing", () => {
  test("rejects unknown options with a nonzero exit (finding #2)", async () => {
    const { run } = spyProgram();
    await expect(run(["list", "--bogus"])).rejects.toMatchObject({
      code: "commander.unknownOption",
      exitCode: 1,
    });
  });

  test("rejects unknown commands and suggests a near match (finding #5)", async () => {
    const { run, err } = spyProgram();
    await expect(run(["frobnicate"])).rejects.toMatchObject({
      code: "commander.unknownCommand",
    });
    expect(err().toLowerCase()).toContain("unknown command");
  });

  test("--version prints the version", async () => {
    const { run, out } = spyProgram();
    await expect(run(["--version"])).rejects.toMatchObject({ code: "commander.version" });
    expect(out()).toContain(VERSION);
  });

  test("per-command help is specific to the command (finding #3)", async () => {
    const { run, out } = spyProgram();
    await expect(run(["integrate", "--help"])).rejects.toMatchObject({
      code: "commander.helpDisplayed",
    });
    const help = out();
    expect(help).toContain("integrate");
    expect(help).toContain("--dry-run");
    expect(help).toContain("--keep-worktree");
    // The other commands' flags do NOT leak into integrate's help.
    expect(help).not.toContain("--concurrency");
  });
});

describe("hopper CLI flag routing", () => {
  test("-p is an alias for --priority", async () => {
    const { run, calls } = spyProgram();
    await run(["add", "do the thing", "-p", "high"]);
    expect(calls.add?.[0]?.flags.priority).toBe("high");
  });

  test("--depends-on merges into --after-item", async () => {
    const { run, calls } = spyProgram();
    await run(["add", "desc", "--depends-on", "abc123"]);
    expect(calls.add?.[0]?.arrayFlags["after-item"]).toEqual(["abc123"]);
  });

  test("--tag is repeatable", async () => {
    const { run, calls } = spyProgram();
    await run(["list", "--tag", "a", "--tag", "b"]);
    expect(calls.list?.[0]?.arrayFlags.tag).toEqual(["a", "b"]);
  });

  test("--after-item is repeatable", async () => {
    const { run, calls } = spyProgram();
    await run(["add", "desc", "--after-item", "id1", "--after-item", "id2"]);
    expect(calls.add?.[0]?.arrayFlags["after-item"]).toEqual(["id1", "id2"]);
  });

  test("--json sets the json flag", async () => {
    const { run, calls } = spyProgram();
    await run(["list", "--all", "--json"]);
    expect(calls.list?.[0]?.flags.json).toBe(true);
    expect(calls.list?.[0]?.flags.all).toBe(true);
  });

  test("tag collects id plus variadic tag positionals", async () => {
    const { run, calls } = spyProgram();
    await run(["tag", "item-id", "tagname", "second"]);
    expect(calls.tag?.[0]?.positional).toEqual(["item-id", "tagname", "second"]);
  });

  test("preset add routes the subverb into positional[0]", async () => {
    const { run, calls } = spyProgram();
    await run(["preset", "add", "nightly", "run the digest", "--dir", "/tmp/x"]);
    expect(calls.preset?.[0]?.positional).toEqual(["add", "nightly", "run the digest"]);
    expect(calls.preset?.[0]?.flags.dir).toBe("/tmp/x");
  });

  test("bare profiles lists (empty positional)", async () => {
    const { run, calls } = spyProgram();
    await run(["profiles"]);
    expect(calls.profiles?.[0]?.positional).toEqual([]);
  });

  test("profiles show routes the subverb + name", async () => {
    const { run, calls } = spyProgram();
    await run(["profiles", "show", "anthropic"]);
    expect(calls.profiles?.[0]?.positional).toEqual(["show", "anthropic"]);
  });
});
