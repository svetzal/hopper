/**
 * Represents the outcome of a CLI command.
 * Commands return this instead of performing I/O directly.
 */
export type CommandResult<T = unknown> =
  | { status: "success"; data: T; humanOutput: string; warnings?: string[] }
  | { status: "error"; message: string; exitCode?: number };
