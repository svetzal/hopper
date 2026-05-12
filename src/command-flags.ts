import type { ParsedArgs } from "./cli.ts";
import type { Result } from "./result.ts";
import { CommandErrorSignal } from "./result.ts";

/** Extract a string flag, returning undefined if it's boolean or missing. */
export function stringFlag(parsed: ParsedArgs, name: string): string | undefined {
  const v = parsed.flags[name];
  return typeof v === "string" ? v : undefined;
}

/** Extract a boolean flag (true if present, false otherwise). */
export function booleanFlag(parsed: ParsedArgs, name: string): boolean {
  return parsed.flags[name] === true;
}

/** The error variant of CommandResult, independent of the data type parameter. */
export type CommandError = { status: "error"; message: string; exitCode?: number };

/**
 * Require a positional argument at the given index.
 * Returns ok: true with the value if present, or ok: false with an error result.
 */
export function requirePositional(
  parsed: ParsedArgs,
  index: number,
  usage: string,
): Result<string, CommandError> {
  const value = parsed.positional[index];
  if (!value) {
    return { ok: false, error: { status: "error", message: usage } };
  }
  return { ok: true, value };
}

/**
 * Require a positional argument at the given index, throwing `CommandErrorSignal` if missing.
 * Use inside a `catchCommandError`-wrapped command body.
 */
export function unwrapPositional(parsed: ParsedArgs, index: number, usage: string): string {
  const result = requirePositional(parsed, index, usage);
  if (!result.ok) throw new CommandErrorSignal(result.error);
  return result.value;
}
