import type { ParsedArgs } from "../cli.ts";
import { loadItems } from "../store.ts";
import { Status } from "../constants.ts";
import type { Item } from "../store.ts";
import { relativeTime, relativeTimeFuture, formatDuration, shortId } from "../format.ts";
import { parsePriority, priorityBadge, comparePriority } from "../priority.ts";
import { normalizeTag, matchesTags } from "../tags.ts";

export async function listCommand(parsed: ParsedArgs): Promise<void> {
  const allItems = await loadItems();

  let items: Item[];
  if (parsed.flags.completed === true) {
    items = allItems.filter((i) => i.status === Status.COMPLETED);
  } else if (parsed.flags.scheduled === true) {
    items = allItems.filter((i) => i.status === Status.SCHEDULED);
  } else if (parsed.flags.all === true) {
    items = allItems;
  } else {
    items = allItems.filter((i) => i.status === Status.QUEUED || i.status === Status.IN_PROGRESS || i.status === Status.SCHEDULED || i.status === Status.BLOCKED);
  }

  const priorityFilter = typeof parsed.flags.priority === "string" ? parsed.flags.priority : undefined;
  if (priorityFilter) {
    try {
      const p = parsePriority(priorityFilter);
      items = items.filter((i) => (i.priority ?? 'normal') === p);
    } catch (e) {
      console.error((e as Error).message);
      process.exit(1);
    }
  }

  const tagFilter = parsed.arrayFlags["tag"] ?? [];
  if (tagFilter.length > 0) {
    try {
      const normalizedTags = tagFilter.map(normalizeTag);
      items = items.filter((i) => matchesTags(i.tags, normalizedTags));
    } catch (e) {
      console.error((e as Error).message);
      process.exit(1);
    }
  }

  items.sort((a, b) => {
    const pc = comparePriority(a.priority, b.priority);
    if (pc !== 0) return pc;
    return new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime();
  });

  if (items.length === 0) {
    console.log("Queue is empty.");
    return;
  }

  if (parsed.flags.json === true) {
    console.log(JSON.stringify(items, null, 2));
    return;
  }

  for (const item of items) {
    const snippet =
      item.description.length > 80
        ? item.description.slice(0, 80).trim() + "..."
        : item.description;

    const id = shortId(item.id);
    const timing = itemTiming(item);
    const pBadge = priorityBadge(item.priority);
    const tagBadge = item.tags?.length ? ` [${item.tags.join(", ")}]` : "";
    const dirBadge = item.workingDir ? ` [dir]` : "";
    const recurrenceBadge = item.recurrence && item.scheduledAt
      ? ` [\u{1F504} every ${item.recurrence.interval}${item.recurrence.remainingRuns !== undefined ? `, ${item.recurrence.remainingRuns} left` : ""}, next: ${relativeTimeFuture(item.scheduledAt)}]`
      : "";
    const scheduledBadge = item.status === Status.SCHEDULED && item.scheduledAt && !item.recurrence
      ? ` [scheduled ${relativeTimeFuture(item.scheduledAt)}]`
      : "";
    const blockedBadge = item.status === Status.BLOCKED && item.dependsOn
      ? ` [blocked on ${item.dependsOn.map(id => shortId(id)).join(", ")}]`
      : "";
    const badge =
      item.status === Status.IN_PROGRESS ? " [in progress]" :
      item.status === Status.CANCELLED ? " [cancelled]" :
      item.status === Status.BLOCKED ? blockedBadge :
      item.recurrence ? recurrenceBadge :
      item.status === Status.SCHEDULED ? scheduledBadge : "";

    console.log(`  ${id}${badge}${pBadge}${tagBadge}${dirBadge}  ${item.title}${timing}`);
    console.log(`    ${snippet}`);
    console.log();
  }
}

function itemTiming(item: Item): string {
  if (item.status === Status.COMPLETED && item.claimedAt && item.completedAt) {
    return `  (completed in ${formatDuration(item.claimedAt, item.completedAt)})`;
  }
  if (item.status === Status.IN_PROGRESS && item.claimedAt) {
    const by = item.claimedBy ? ` by ${item.claimedBy}` : "";
    return `  (claimed${by} ${relativeTime(item.claimedAt)})`;
  }
  return `  (added ${relativeTime(item.createdAt)})`;
}
