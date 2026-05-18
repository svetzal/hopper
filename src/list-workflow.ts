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
    items = allItems.filter(
      (i) =>
        i.status === Status.QUEUED ||
        i.status === Status.IN_PROGRESS ||
        i.status === Status.SCHEDULED ||
        i.status === Status.BLOCKED,
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
 * Infer which engineering phase an in-progress item is currently running, based
 * on the `phases` record (which is only written at phase *completion*). Returns
 * undefined for non-engineering items, items not in_progress, or completed
 * validate runs awaiting completion.
 *
 * Phase records are written when a phase ends, so the *next* phase is the one
 * currently running:
 *   - 0 records → plan
 *   - last record = plan → execute
 *   - last record = execute → validate
 *   - last record = validate (failed) → execute (retry N)
 *   - last record = validate (passed) → undefined (item about to complete)
 */
export function inferEngineeringPhase(item: Item): string | undefined {
  if (item.type !== "engineering") return undefined;
  if (item.status !== Status.IN_PROGRESS) return undefined;

  const phases = item.phases ?? [];
  if (phases.length === 0) return "plan";

  const last = phases[phases.length - 1];
  if (!last) return "plan";

  if (last.name === "plan") return "execute";
  if (last.name === "execute") return "validate";
  if (last.name === "validate") {
    if (last.passed) return undefined;
    const executeAttempts = phases.filter((p) => p.name === "execute").length;
    return `execute (retry ${executeAttempts})`;
  }
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
      return phase ? ` [in progress: ${phase}]` : " [in progress]";
    })();
    const badge =
      item.status === Status.IN_PROGRESS
        ? inProgressBadge
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
