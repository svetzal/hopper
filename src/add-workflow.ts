import { isTaskType, Status, TaskType } from "./constants.ts";
import { parseDuration, parseTimeSpec } from "./parse-time.ts";
import type { Priority } from "./priority.ts";
import { err, ok, type Result } from "./result.ts";
import type { Item } from "./store.ts";

// ---------------------------------------------------------------------------
// Validation error discriminated union
// ---------------------------------------------------------------------------

export type AddValidationError =
  | { code: "MISSING_DESCRIPTION" }
  | { code: "BRANCH_REQUIRES_DIR" }
  | { code: "DIR_REQUIRES_BRANCH_OR_COMMAND" }
  | { code: "TIMES_REQUIRES_EVERY" }
  | { code: "TIMES_INVALID"; value: string }
  | { code: "UNTIL_REQUIRES_EVERY" }
  | { code: "EVERY_INVALID"; value: string }
  | { code: "EVERY_TOO_SHORT"; minimumMinutes: number }
  | { code: "UNTIL_BEFORE_START"; until: string; start: string }
  | { code: "CIRCULAR_DEPENDENCY" }
  | { code: "DEP_NOT_FOUND"; idPrefix: string }
  | { code: "DEP_AMBIGUOUS"; idPrefix: string; matchCount: number }
  | { code: "INVALID_TYPE"; value: string }
  | { code: "INVESTIGATION_NO_BRANCH" }
  | { code: "RETRIES_INVALID"; value: string }
  | { code: "RETRIES_TOO_HIGH"; value: number; max: number };

// ---------------------------------------------------------------------------
// Task type validation
// ---------------------------------------------------------------------------

/**
 * Validate the --type flag. Accepts undefined (no type set) and any known
 * TaskType. Returns the normalized TaskType or an error.
 */
export function validateTaskType(
  raw: string | undefined,
): Result<TaskType | undefined, AddValidationError> {
  if (raw === undefined) return ok(undefined);
  if (isTaskType(raw)) return ok(raw);
  return err({ code: "INVALID_TYPE", value: raw });
}

// ---------------------------------------------------------------------------
// Retries validation
// ---------------------------------------------------------------------------

export const MAX_RETRIES = 5;

/**
 * Validate the --retries flag. Accepts undefined, or a non-negative integer
 * up to MAX_RETRIES. Values above the cap are rejected outright so an
 * accidental `--retries 100` cannot burn through a credit card.
 */
export function validateRetries(
  raw: string | undefined,
): Result<number | undefined, AddValidationError> {
  if (raw === undefined) return ok(undefined);
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0) {
    return err({ code: "RETRIES_INVALID", value: raw });
  }
  if (n > MAX_RETRIES) {
    return err({ code: "RETRIES_TOO_HIGH", value: n, max: MAX_RETRIES });
  }
  return ok(n);
}

// ---------------------------------------------------------------------------
// Dir/branch validation
// ---------------------------------------------------------------------------

/**
 * Validate the dir/branch/command combination for the given task type.
 *
 * Default (task / engineering / undefined type):
 *   - dir alone (without branch or command) is not meaningful.
 *   - branch without dir cannot be checked out.
 *
 * Investigation items are read-only: no worktree, no branch. `--dir` alone is
 * fine; `--branch` is rejected because it implies a worktree.
 */
export function validateDirBranch(
  dir: string | undefined,
  branch: string | undefined,
  command: string | undefined,
  type?: TaskType,
): AddValidationError | null {
  if (type === TaskType.INVESTIGATION) {
    if (branch) return { code: "INVESTIGATION_NO_BRANCH" };
    return null;
  }
  if (dir && !branch && !command) return { code: "DIR_REQUIRES_BRANCH_OR_COMMAND" };
  if (branch && !dir) return { code: "BRANCH_REQUIRES_DIR" };
  return null;
}

// ---------------------------------------------------------------------------
// Times spec validation
// ---------------------------------------------------------------------------

/**
 * Validate the --times flag value.
 * Returns the parsed integer on success or an error on failure.
 * --times requires --every to also be set.
 */
export function validateTimesSpec(
  timesSpec: string | undefined,
  everySpec: string | undefined,
): Result<number | undefined, AddValidationError> {
  if (timesSpec && !everySpec) return err({ code: "TIMES_REQUIRES_EVERY" });
  if (!timesSpec) return ok(undefined);
  const n = parseInt(timesSpec, 10);
  if (!Number.isInteger(n) || n < 1) return err({ code: "TIMES_INVALID", value: timesSpec });
  return ok(n);
}

// ---------------------------------------------------------------------------
// Scheduling resolution
// ---------------------------------------------------------------------------

export interface RecurrenceResult {
  status: string;
  scheduledAt?: string;
  recurrence?: {
    interval: string;
    intervalMs: number;
    until?: string;
    remainingRuns?: number;
  };
}

const MIN_INTERVAL_MS = 5 * 60_000; // 5 minutes

/**
 * Resolve the scheduling fields (status, scheduledAt, recurrence) from the
 * raw flag values. All time-parsing and validation happens here.
 *
 * @param everySpec   The --every flag value (e.g. "4h", "30m")
 * @param afterSpec   The --after flag value (e.g. "2h", "tomorrow 9am")
 * @param untilSpec   The --until flag value
 * @param timesValue  The already-validated --times integer (or undefined)
 * @param now         Current time (injected for testability)
 */
export function resolveScheduling(
  everySpec: string | undefined,
  afterSpec: string | undefined,
  untilSpec: string | undefined,
  timesValue: number | undefined,
  now: Date,
): Result<RecurrenceResult, AddValidationError> {
  if (untilSpec && !everySpec) {
    return err({ code: "UNTIL_REQUIRES_EVERY" });
  }

  if (everySpec) {
    const durResult = parseDuration(everySpec);
    if (!durResult.ok) return err({ code: "EVERY_INVALID", value: everySpec });
    const intervalMs = durResult.value;

    if (intervalMs < MIN_INTERVAL_MS) {
      return err({ code: "EVERY_TOO_SHORT", minimumMinutes: MIN_INTERVAL_MS / 60_000 });
    }

    let scheduledAt: string;
    if (afterSpec) {
      const afterResult = parseTimeSpec(afterSpec);
      if (!afterResult.ok) return err({ code: "EVERY_INVALID", value: afterSpec });
      scheduledAt = afterResult.value.toISOString();
    } else {
      scheduledAt = new Date(now.getTime() + intervalMs).toISOString();
    }

    const recurrence: RecurrenceResult["recurrence"] = { interval: everySpec, intervalMs };

    if (timesValue !== undefined) {
      recurrence.remainingRuns = timesValue - 1;
    }

    if (untilSpec) {
      const untilResult = parseTimeSpec(untilSpec);
      if (!untilResult.ok) return err({ code: "EVERY_INVALID", value: untilSpec });
      const untilDate = untilResult.value;
      if (untilDate.getTime() <= new Date(scheduledAt).getTime()) {
        return err({ code: "UNTIL_BEFORE_START", until: untilSpec, start: scheduledAt });
      }
      recurrence.until = untilDate.toISOString();
    }

    return ok({ status: Status.SCHEDULED, scheduledAt, recurrence });
  }

  if (afterSpec) {
    const afterOnlyResult = parseTimeSpec(afterSpec);
    if (!afterOnlyResult.ok) return err({ code: "EVERY_INVALID", value: afterSpec });
    const scheduledAt = afterOnlyResult.value.toISOString();
    return ok({ status: Status.SCHEDULED, scheduledAt });
  }

  return ok({ status: Status.QUEUED });
}

// ---------------------------------------------------------------------------
// Cycle detection
// ---------------------------------------------------------------------------

/**
 * Detect whether adding the given dependency IDs would create a cycle.
 * Returns true if a cycle is detected.
 *
 * The algorithm checks that none of the transitive dependencies of the
 * candidate dep IDs point back to another candidate dep ID.
 */
export function hasCycle(depIds: string[], allItems: Item[]): boolean {
  const depSet = new Set(depIds);

  for (const startId of depIds) {
    const visited = new Set<string>();
    const stack = [startId];

    while (stack.length > 0) {
      const current = stack.pop() as string;
      if (visited.has(current)) continue;
      visited.add(current);

      const item = allItems.find((i) => i.id === current);
      if (!item?.dependsOn) continue;

      for (const parentId of item.dependsOn) {
        if (depSet.has(parentId)) {
          return true;
        }
        stack.push(parentId);
      }
    }
  }

  return false;
}

// ---------------------------------------------------------------------------
// Dependency resolution
// ---------------------------------------------------------------------------

export type DepResolutionResult = Result<
  { resolvedIds: string[]; warnings: string[] },
  AddValidationError
>;

/**
 * Resolve dependency ID prefixes to full item IDs.
 *
 * For each prefix:
 * - 0 matches → DEP_NOT_FOUND error
 * - >1 matches → DEP_AMBIGUOUS error
 * - completed dep → adds a warning (not an error)
 *
 * After resolving all IDs, checks for circular dependencies.
 */
export function resolveDependencies(idPrefixes: string[], allItems: Item[]): DepResolutionResult {
  const resolvedIds: string[] = [];
  const warnings: string[] = [];

  for (const idPrefix of idPrefixes) {
    const matches = allItems.filter((i) => i.id === idPrefix || i.id.startsWith(idPrefix));

    if (matches.length === 0) {
      return err({ code: "DEP_NOT_FOUND", idPrefix });
    }
    if (matches.length > 1) {
      return err({ code: "DEP_AMBIGUOUS", idPrefix, matchCount: matches.length });
    }

    const dep = matches[0] as (typeof matches)[0];
    if (dep.status === Status.COMPLETED) {
      warnings.push(`Warning: dependency ${dep.id.slice(0, 8)} is already completed`);
    }
    resolvedIds.push(dep.id);
  }

  if (hasCycle(resolvedIds, allItems)) {
    return err({ code: "CIRCULAR_DEPENDENCY" });
  }

  return ok({ resolvedIds, warnings });
}

// ---------------------------------------------------------------------------
// Item construction
// ---------------------------------------------------------------------------

/**
 * Construct a new Item from validated, resolved parameters.
 * This is a pure function — no I/O, no side effects.
 */
export function buildNewItem(params: {
  id: string;
  title: string;
  description: string;
  status: string;
  createdAt: string;
  priority?: Priority;
  scheduledAt?: string;
  dir?: string;
  branch?: string;
  command?: string;
  recurrence?: RecurrenceResult["recurrence"];
  dependsOn?: string[];
  tags?: string[];
  type?: TaskType;
  agent?: string;
  retries?: number;
}): Item {
  return {
    id: params.id,
    title: params.title,
    description: params.description,
    status: params.status as Item["status"],
    createdAt: params.createdAt,
    ...(params.priority && params.priority !== "normal" ? { priority: params.priority } : {}),
    ...(params.scheduledAt ? { scheduledAt: params.scheduledAt } : {}),
    ...(params.dir ? { workingDir: params.dir } : {}),
    ...(params.branch ? { branch: params.branch } : {}),
    ...(params.command ? { command: params.command } : {}),
    ...(params.recurrence ? { recurrence: params.recurrence } : {}),
    ...(params.dependsOn ? { dependsOn: params.dependsOn } : {}),
    ...(params.tags?.length ? { tags: params.tags } : {}),
    ...(params.type ? { type: params.type } : {}),
    ...(params.agent ? { agent: params.agent } : {}),
    ...(params.retries !== undefined ? { retries: params.retries } : {}),
  };
}

// ---------------------------------------------------------------------------
// Error formatting
// ---------------------------------------------------------------------------

/**
 * Convert an AddValidationError into a human-readable message
 * matching the original console.error output of add.ts exactly.
 */
export function formatValidationError(error: AddValidationError): string {
  switch (error.code) {
    case "MISSING_DESCRIPTION":
      return 'Usage: hopper add <description>\n  or:  echo "description" | hopper add';
    case "BRANCH_REQUIRES_DIR":
      return "Error: --branch requires --dir";
    case "DIR_REQUIRES_BRANCH_OR_COMMAND":
      return "Error: --branch is required when --dir is set (unless --command is provided)";
    case "TIMES_REQUIRES_EVERY":
      return "Error: --times requires --every";
    case "TIMES_INVALID":
      return "Error: --times must be a positive integer";
    case "UNTIL_REQUIRES_EVERY":
      return "Error: --until requires --every";
    case "EVERY_INVALID":
      return `Error: --every requires a relative duration (e.g. 4h, 30m, 1d), got "${error.value}"`;
    case "EVERY_TOO_SHORT":
      return "Error: minimum recurrence interval is 5 minutes";
    case "UNTIL_BEFORE_START":
      return "Error: --until must be after the scheduled start time";
    case "CIRCULAR_DEPENDENCY":
      return "Circular dependency detected";
    case "DEP_NOT_FOUND":
      return `No item found with id: ${error.idPrefix}`;
    case "DEP_AMBIGUOUS":
      return `Ambiguous id prefix "${error.idPrefix}" matches ${error.matchCount} items. Use a longer prefix.`;
    case "INVALID_TYPE":
      return `Error: --type must be one of: investigation, engineering, task (got "${error.value}")`;
    case "INVESTIGATION_NO_BRANCH":
      return "Error: investigation items cannot have --branch (investigations run read-only, with no worktree)";
    case "RETRIES_INVALID":
      return `Error: --retries must be a non-negative integer, got "${error.value}"`;
    case "RETRIES_TOO_HIGH":
      return `Error: --retries is capped at ${error.max} (got ${error.value})`;
  }
}
