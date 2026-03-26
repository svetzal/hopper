/**
 * Represents the outcome of a CLI command.
 * Commands return this instead of performing I/O directly.
 */
export type CommandResult =
  | { status: "success"; data: unknown; humanOutput: string; warnings?: string[] }
  | { status: "error"; message: string; exitCode?: number };
