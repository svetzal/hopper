import type { CommandResult } from "./command-result.ts";

export type Result<T, E = string> = { ok: true; value: T } | { ok: false; error: E };

export function ok<T>(value: T): Result<T, never> {
  return { ok: true, value };
}

export function err<E>(error: E): Result<never, E> {
  return { ok: false, error };
}

/** The error-only shape returned by `unwrapOrError` on failure. */
export type CommandErrorResult = { status: "error"; message: string };

/**
 * Unwraps a Result on success, or returns a `CommandErrorResult` on failure.
 *
 * The single-argument form requires the error to be a string.
 * The two-argument form accepts a mapper to convert a non-string error.
 *
 * Pair with `isCommandError` to narrow the result before using the value.
 */
export function unwrapOrError<T>(result: Result<T, string>): T | CommandErrorResult;
export function unwrapOrError<T, E>(
  result: Result<T, E>,
  mapper: (e: E) => string,
): T | CommandErrorResult;
export function unwrapOrError<T, E>(
  result: Result<T, E>,
  mapper?: (e: E) => string,
): T | CommandErrorResult {
  if (result.ok) return result.value;
  const message = mapper ? mapper(result.error) : (result.error as unknown as string);
  return { status: "error", message };
}

/**
 * Type guard that checks whether a value is a `CommandErrorResult`.
 * Use this after `unwrapOrError` to branch on failure before using the value.
 */
export function isCommandError(v: unknown): v is CommandErrorResult {
  return (
    typeof v === "object" &&
    v !== null &&
    "status" in v &&
    (v as { status: unknown }).status === "error"
  );
}

/** Internal sentinel thrown by `unwrap`/`unwrapPositional`; caught only by `catchCommandError`. */
export class CommandErrorSignal extends Error {
  constructor(public readonly result: CommandErrorResult) {
    super(result.message);
    this.name = "CommandErrorSignal";
  }
}

/** Unwraps a Result, returning the value on success or throwing `CommandErrorSignal` on failure. */
export function unwrap<T>(result: Result<T, string>): T;
export function unwrap<T, E>(result: Result<T, E>, mapper: (e: E) => string): T;
export function unwrap<T, E>(result: Result<T, E>, mapper?: (e: E) => string): T {
  if (result.ok) return result.value;
  const message = mapper ? mapper(result.error) : (result.error as unknown as string);
  throw new CommandErrorSignal({ status: "error", message });
}

/**
 * Wraps a command body: catches any `CommandErrorSignal` thrown by `unwrap`/`unwrapPositional`
 * and returns it as a `CommandResult` error. All other exceptions propagate normally.
 */
export async function catchCommandError<T>(
  fn: () => Promise<CommandResult<T>>,
): Promise<CommandResult<T>> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof CommandErrorSignal) return e.result;
    throw e;
  }
}
