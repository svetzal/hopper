import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import type { ParsedArgs } from "./cli.ts";
import type { CommandResult } from "./command-result.ts";
import { runCommand } from "./command-runner.ts";

function makeParsed(flags: Record<string, string | boolean> = {}): ParsedArgs {
  return { command: "test", positional: [], flags, arrayFlags: {} };
}

describe("runCommand", () => {
  let consoleLogSpy: ReturnType<typeof spyOn>;
  let consoleErrorSpy: ReturnType<typeof spyOn>;
  let consoleWarnSpy: ReturnType<typeof spyOn>;
  let processExitSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    consoleLogSpy = spyOn(console, "log").mockImplementation(() => {});
    consoleErrorSpy = spyOn(console, "error").mockImplementation(() => {});
    consoleWarnSpy = spyOn(console, "warn").mockImplementation(() => {});
    processExitSpy = spyOn(process, "exit").mockImplementation((_code?: number) => {
      throw new Error(`process.exit(${_code})`);
    });
  });

  afterEach(() => {
    consoleLogSpy.mockRestore();
    consoleErrorSpy.mockRestore();
    consoleWarnSpy.mockRestore();
    processExitSpy.mockRestore();
  });

  test("success without --json prints humanOutput", async () => {
    const fn = mock(
      async (_p: ParsedArgs): Promise<CommandResult> => ({
        status: "success",
        data: { id: "abc" },
        humanOutput: "Added: test item",
      }),
    );

    await runCommand(fn, makeParsed());

    expect(consoleLogSpy).toHaveBeenCalledWith("Added: test item");
    expect(consoleLogSpy).toHaveBeenCalledTimes(1);
  });

  test("success with --json prints JSON.stringify(data)", async () => {
    const data = { id: "abc", title: "hello" };
    const fn = mock(
      async (_p: ParsedArgs): Promise<CommandResult> => ({
        status: "success",
        data,
        humanOutput: "Added: hello",
      }),
    );

    await runCommand(fn, makeParsed({ json: true }));

    expect(consoleLogSpy).toHaveBeenCalledWith(JSON.stringify(data, null, 2));
  });

  test("success with warnings prints warnings to stderr before humanOutput", async () => {
    const fn = mock(
      async (_p: ParsedArgs): Promise<CommandResult> => ({
        status: "success",
        data: {},
        humanOutput: "Cancelled: item",
        warnings: ["Warning: 2 items depend on this."],
      }),
    );

    await runCommand(fn, makeParsed());

    expect(consoleWarnSpy).toHaveBeenCalledWith("Warning: 2 items depend on this.");
    expect(consoleLogSpy).toHaveBeenCalledWith("Cancelled: item");
  });

  test("error result prints message to stderr and exits with specified code", async () => {
    const fn = mock(
      async (_p: ParsedArgs): Promise<CommandResult> => ({
        status: "error",
        message: "Usage: hopper cancel <item-id>",
        exitCode: 1,
      }),
    );

    await expect(runCommand(fn, makeParsed())).rejects.toThrow("process.exit(1)");
    expect(consoleErrorSpy).toHaveBeenCalledWith("Usage: hopper cancel <item-id>");
  });

  test("error result defaults to exit code 1 when exitCode is not specified", async () => {
    const fn = mock(
      async (_p: ParsedArgs): Promise<CommandResult> => ({
        status: "error",
        message: "No queued items available.",
      }),
    );

    await expect(runCommand(fn, makeParsed())).rejects.toThrow("process.exit(1)");
    expect(processExitSpy).toHaveBeenCalledWith(1);
  });

  test("thrown exception prints error message to stderr and exits with code 1", async () => {
    const fn = mock(async (_p: ParsedArgs): Promise<CommandResult> => {
      throw new Error("Something went wrong");
    });

    await expect(runCommand(fn, makeParsed())).rejects.toThrow("process.exit(1)");
    expect(consoleErrorSpy).toHaveBeenCalledWith("Something went wrong");
    expect(processExitSpy).toHaveBeenCalledWith(1);
  });
});
