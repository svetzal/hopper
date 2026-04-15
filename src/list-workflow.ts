import { isTaskType, Status, type TaskType } from "./constants.ts";
import { toErrorMessage } from "./error-utils.ts";
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
    try {
      const p = parsePriority(priorityFilter);
      items = items.filter((i) => (i.priority ?? "normal") === p);
    } catch (e) {
      return { ok: false, error: toErrorMessage(e) };
    }
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

/** Format a single item timing annotation. */
export function itemTiming(item: Item): string {
  if (item.status === Status.COMPLETED && item.claimedAt && item.completedAt) {
    return `  (completed in ${formatDuration(item.claimedAt, item.completedAt)})`;
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
    const badge =
      item.status === Status.IN_PROGRESS
        ? " [in progress]"
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
