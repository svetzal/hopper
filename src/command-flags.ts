import type { ParsedArgs } from "./cli.ts";
import type { CommandResult } from "./command-result.ts";
import type { Result } from "./result.ts";

/** Extract a string flag, returning undefined if it's boolean or missing. */
export function stringFlag(parsed: ParsedArgs, name: string): string | undefined {
  const v = parsed.flags[name];
  return typeof v === "string" ? v : undefined;
}

/** Extract a boolean flag (true if present, false otherwise). */
export function booleanFlag(parsed: ParsedArgs, name: string): boolean {
  return parsed.flags[name] === true;
}

/**
 * Require a positional argument at the given index.
 * Returns ok: true with the value if present, or ok: false with an error CommandResult.
 */
export function requirePositional(
  parsed: ParsedArgs,
  index: number,
  usage: string,
): Result<string, CommandResult> {
  const value = parsed.positional[index];
  if (!value) {
    return { ok: false, error: { status: "error", message: usage } };
  }
  return { ok: true, value };
}
