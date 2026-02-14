import type { ParsedArgs } from "../cli.ts";
import { loadItems } from "../store.ts";
import type { Item } from "../store.ts";
import { relativeTime, formatDuration, shortId } from "../format.ts";

export async function listCommand(parsed: ParsedArgs): Promise<void> {
  const allItems = await loadItems();

  let items: Item[];
  if (parsed.flags.completed === true) {
    items = allItems.filter((i) => i.status === "completed");
  } else if (parsed.flags.all === true) {
    items = allItems;
  } else {
    items = allItems.filter((i) => i.status !== "completed");
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
    const badge = item.status === "in_progress" ? " [in progress]" : "";

    console.log(`  ${id}${badge}  ${item.title}${timing}`);
    console.log(`    ${snippet}`);
    console.log();
  }
}

function itemTiming(item: Item): string {
  if (item.status === "completed" && item.claimedAt && item.completedAt) {
    return `  (completed in ${formatDuration(item.claimedAt, item.completedAt)})`;
  }
  if (item.status === "in_progress" && item.claimedAt) {
    const by = item.claimedBy ? ` by ${item.claimedBy}` : "";
    return `  (claimed${by} ${relativeTime(item.claimedAt)})`;
  }
  return `  (added ${relativeTime(item.createdAt)})`;
}
