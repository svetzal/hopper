import type { ParsedArgs } from "./cli.ts";

/** Extract a string flag, returning undefined if it's boolean or missing. */
export function stringFlag(parsed: ParsedArgs, name: string): string | undefined {
  const v = parsed.flags[name];
  return typeof v === "string" ? v : undefined;
}

/** Extract a boolean flag (true if present, false otherwise). */
export function booleanFlag(parsed: ParsedArgs, name: string): boolean {
  return parsed.flags[name] === true;
}
