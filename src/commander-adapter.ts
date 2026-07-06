import type { ParsedArgs } from "./cli.ts";

/**
 * Convert a commander camelCase option key back to its kebab-case flag name.
 *
 * Commander exposes `--dry-run` as `opts.dryRun` and `--after-item` as
 * `opts.afterItem`. The command bodies, however, read flags by their
 * kebab-case names (`parsed.flags["dry-run"]`, `parsed.arrayFlags["after-item"]`).
 * Every hopper option is lowercase-kebab, so the camelCase form is a lossless,
 * reversible encoding.
 */
export function camelToKebab(key: string): string {
  return key.replace(/[A-Z]/g, (m) => `-${m.toLowerCase()}`);
}

/**
 * Adapt commander's parsed output (positional arguments plus its options
 * object) into the legacy {@link ParsedArgs} shape the command bodies consume.
 *
 * - Array-valued options (repeatable flags like `--tag`, `--after-item`) route
 *   into `arrayFlags`.
 * - Scalar and boolean options route into `flags`.
 * - `undefined` options are dropped, so `booleanFlag()` / `stringFlag()` see an
 *   unset option as genuinely absent rather than as `false`/`""`.
 */
export function toParsedArgs(
  positional: string[],
  opts: Record<string, unknown>,
  command = "",
): ParsedArgs {
  const flags: Record<string, string | boolean> = {};
  const arrayFlags: Record<string, string[]> = {};

  for (const [rawKey, value] of Object.entries(opts)) {
    if (value === undefined) continue;
    const key = camelToKebab(rawKey);
    if (Array.isArray(value)) {
      arrayFlags[key] = value as string[];
    } else if (typeof value === "string" || typeof value === "boolean") {
      flags[key] = value;
    }
  }

  return { command, positional, flags, arrayFlags };
}

/** Collector for commander repeatable options: `.option("--tag <t>", d, collect, [])`. */
export function collect(value: string, previous: string[]): string[] {
  return previous.concat(value);
}
