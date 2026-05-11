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
  const message = mapper
    ? mapper(result.error)
    : (result.error as unknown as string);
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
