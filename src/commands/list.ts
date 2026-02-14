import type { ParsedArgs } from "../cli.ts";
import { loadItems } from "../store.ts";

export async function listCommand(parsed: ParsedArgs): Promise<void> {
  const items = await loadItems();

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
    console.log(`  ${item.title}`);
    console.log(`    ${snippet}`);
    console.log();
  }
}
