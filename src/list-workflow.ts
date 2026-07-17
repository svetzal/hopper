import { isTaskType, Status, type TaskType } from "./constants.ts";
import { formatDuration, relativeTime, relativeTimeFuture, shortId } from "./format.ts";
import { comparePriority, parsePriority, priorityBadge } from "./priority.ts";
import type { Result } from "./result.ts";
import type { Item } from "./store.ts";
import { matchesTags, normalizeTags, tagBadge } from "./tags.ts";

/** Short badge string for display in list output. Empty string for default type. */
export function taskTypeBadge(type: TaskType | undefined): string {
  switch (type) {
    case "investigation":
      return " [inv]";
    case "engineering":
      return " [eng]";
    default:
      return "";
  }
}

export type ListFilter =
  | { mode: "default" }
  | { mode: "completed" }
  | { mode: "scheduled" }
  | { mode: "all" };

/**
 * Filter and sort items based on the requested display mode, priority filter,
 * and tag filter. Returns an error string if any filter argument is invalid.
 */
export function filterAndSortItems(
  allItems: Item[],
  filter: ListFilter,
  priorityFilter: string | undefined,
  tagFilter: string[],
  typeFilter?: string,
): Result<Item[]> {
  let items: Item[];

  if (filter.mode === "completed") {
    items = allItems.filter((i) => i.status === Status.COMPLETED);
  } else if (filter.mode === "scheduled") {
    items = allItems.filter((i) => i.status === Status.SCHEDULED);
  } else if (filter.mode === "all") {
    items = allItems;
  } else {
    // Failed items are part of the default view: they hold preserved worktrees
    // awaiting a human decision (requeue / integrate / cancel), so hiding them
    // would bury exactly the items that need attention.
    items = allItems.filter(
      (i) =>
        i.status === Status.QUEUED ||
        i.status === Status.IN_PROGRESS ||
        i.status === Status.SCHEDULED ||
        i.status === Status.BLOCKED ||
        i.status === Status.FAILED,
    );
  }

  if (priorityFilter) {
    const p = parsePriority(priorityFilter);
    if (!p.ok) return { ok: false, error: p.error };
    items = items.filter((i) => (i.priority ?? "normal") === p.value);
  }

  if (tagFilter.length > 0) {
    const tagResult = normalizeTags(tagFilter);
    if (!tagResult.ok) return { ok: false, error: tagResult.error };
    items = items.filter((i) => matchesTags(i.tags, tagResult.value));
  }

  if (typeFilter) {
    if (!isTaskType(typeFilter)) {
      return {
        ok: false,
        error: `Error: --type must be one of: investigation, engineering, task (got "${typeFilter}")`,
      };
    }
    items = items.filter((i) => (i.type ?? "task") === typeFilter);
  }

  items.sort((a, b) => {
    const pc = comparePriority(a.priority, b.priority);
    if (pc !== 0) return pc;
    return new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime();
  });

  return { ok: true, value: items };
}

/**
 * Phase status for an in-progress or failed engineering item. `running` means
 * the worker is actively in the named phase; `failed` means the worker bailed
 * (preserving worktree + branch) awaiting human action.
 */
export type EngineeringPhaseStatus =
  | { kind: "running"; phase: string }
  | { kind: "failed"; phase: "plan" | "execute" | "validate" };

/**
 * Infer which engineering phase an item is currently running (or failed at),
 * based on the `phases` record. Records are written at phase *completion*, so
 * the next phase is the running one — unless the last phase exited non-zero or
 * validate didn't pass within the retry budget, in which case the worker
 * bailed. Bailed runs now transition to the terminal `failed` status; the
 * in_progress failure inference is kept for items recorded before that change.
 *
 * Returns undefined for non-engineering items, items in other statuses, or
 * completed validate runs awaiting final completion.
 */
export function inferEngineeringPhase(item: Item): EngineeringPhaseStatus | undefined {
  if (item.type !== "engineering") return undefined;
  if (item.status !== Status.IN_PROGRESS && item.status !== Status.FAILED) return undefined;

  const phases = item.phases ?? [];
  if (phases.length === 0) return { kind: "running", phase: "plan" };

  const last = phases[phases.length - 1];
  if (!last) return { kind: "running", phase: "plan" };

  // Failure paths — worker preserves worktree + branch and stops.
  if (last.name === "plan" && last.exitCode !== 0) {
    return { kind: "failed", phase: "plan" };
  }
  if (last.name === "execute" && last.exitCode !== 0) {
    return { kind: "failed", phase: "execute" };
  }
  if (last.name === "validate" && !last.passed) {
    const executeAttempts = phases.filter((p) => p.name === "execute").length;
    const maxAttempts = (item.retries ?? 1) + 1;
    if (executeAttempts >= maxAttempts) {
      return { kind: "failed", phase: "validate" };
    }
    return { kind: "running", phase: `execute (retry ${executeAttempts})` };
  }

  if (last.name === "plan") return { kind: "running", phase: "execute" };
  if (last.name === "execute") return { kind: "running", phase: "validate" };
  if (last.name === "validate" && last.passed) return undefined;

  return undefined;
}

/** Format a single item timing annotation. */
export function itemTiming(item: Item): string {
  if (item.status === Status.COMPLETED && item.claimedAt && item.completedAt) {
    // Show *when* it completed (relative) and *how long* it took (duration).
    // The previous form ("completed in 1h") collapsed both into one phrase and
    // silently dropped the "when", forcing the reader into `hopper show` or
    // --json to find out whether something finished an hour ago or last week.
    return `  (completed ${relativeTime(item.completedAt)}, took ${formatDuration(item.claimedAt, item.completedAt)})`;
  }
  if (item.status === Status.IN_PROGRESS && item.claimedAt) {
    const by = item.claimedBy ? ` by ${item.claimedBy}` : "";
    return `  (claimed${by} ${relativeTime(item.claimedAt)})`;
  }
  if (item.status === Status.FAILED && item.claimedAt && item.failedAt) {
    return `  (failed ${relativeTime(item.failedAt)}, took ${formatDuration(item.claimedAt, item.failedAt)})`;
  }
  return `  (added ${relativeTime(item.createdAt)})`;
}

/** Format the human-readable list of items as a string. */
export function formatItemList(items: Item[]): string {
  if (items.length === 0) {
    return "Queue is empty.";
  }

  const lines: string[] = [];
  for (const item of items) {
    const snippet =
      item.description.length > 80
        ? `${item.description.slice(0, 80).trim()}...`
        : item.description;

    const id = shortId(item.id);
    const timing = itemTiming(item);
    const pBadge = priorityBadge(item.priority);
    const tBadge = tagBadge(item.tags);
    const typeBadgeStr = taskTypeBadge(item.type);
    const dirBadge = item.workingDir ? ` [dir]` : "";
    const recurrenceBadge =
      item.recurrence && item.scheduledAt
        ? ` [\u{1F504} every ${item.recurrence.interval}${item.recurrence.remainingRuns !== undefined ? `, ${item.recurrence.remainingRuns} left` : ""}, next: ${relativeTimeFuture(item.scheduledAt)}]`
        : "";
    const scheduledBadge =
      item.status === Status.SCHEDULED && item.scheduledAt && !item.recurrence
        ? ` [scheduled ${relativeTimeFuture(item.scheduledAt)}]`
        : "";
    const blockedBadge =
      item.status === Status.BLOCKED && item.dependsOn
        ? ` [blocked on ${item.dependsOn.map((depId) => shortId(depId)).join(", ")}]`
        : "";
    const inProgressBadge = (() => {
      const phase = inferEngineeringPhase(item);
      if (!phase) return " [in progress]";
      if (phase.kind === "failed") return ` [failed at ${phase.phase}]`;
      return ` [in progress: ${phase.phase}]`;
    })();
    const failedBadge = (() => {
      const phase = inferEngineeringPhase(item);
      if (phase?.kind === "failed") return ` [failed at ${phase.phase}]`;
      return " [failed]";
    })();
    const badge =
      item.status === Status.IN_PROGRESS
        ? inProgressBadge
        : item.status === Status.FAILED
          ? failedBadge
          : item.status === Status.CANCELLED
            ? " [cancelled]"
            : item.status === Status.BLOCKED
              ? blockedBadge
              : item.recurrence
                ? recurrenceBadge
                : item.status === Status.SCHEDULED
                  ? scheduledBadge
                  : "";

    lines.push(
      `  ${id}${badge}${pBadge}${tBadge}${typeBadgeStr}${dirBadge}  ${item.title}${timing}`,
    );
    lines.push(`    ${snippet}`);
    lines.push("");
  }

  return lines.join("\n");
}
