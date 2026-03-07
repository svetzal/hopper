import type { ParsedArgs } from "../cli.ts";
import { loadItems } from "../store.ts";
import { Status } from "../constants.ts";
import type { Item } from "../store.ts";
import { relativeTime, relativeTimeFuture, formatDuration, shortId } from "../format.ts";

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
    items = allItems.filter((i) => i.status === Status.QUEUED || i.status === Status.IN_PROGRESS || i.status === Status.SCHEDULED);
  }

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
    const dirBadge = item.workingDir ? ` [dir]` : "";
    const recurrenceBadge = item.recurrence && item.scheduledAt
      ? ` [\u{1F504} every ${item.recurrence.interval}, next: ${relativeTimeFuture(item.scheduledAt)}]`
      : "";
    const scheduledBadge = item.status === Status.SCHEDULED && item.scheduledAt && !item.recurrence
      ? ` [scheduled ${relativeTimeFuture(item.scheduledAt)}]`
      : "";
    const badge =
      item.status === Status.IN_PROGRESS ? " [in progress]" :
      item.status === Status.CANCELLED ? " [cancelled]" :
      item.recurrence ? recurrenceBadge :
      item.status === Status.SCHEDULED ? scheduledBadge : "";

    console.log(`  ${id}${badge}${dirBadge}  ${item.title}${timing}`);
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
