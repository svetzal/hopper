import type { ParsedArgs } from "../cli.ts";
import { cancelItem } from "../store.ts";

export async function cancelCommand(parsed: ParsedArgs): Promise<void> {
  const id = parsed.positional[0];
  if (!id) {
    console.error("Usage: hopper cancel <item-id>");
    process.exit(1);
  }

  try {
    const { item, blockedDependentCount } = await cancelItem(id);

    if (parsed.flags.json === true) {
      console.log(JSON.stringify(item, null, 2));
    } else {
      if (blockedDependentCount > 0) {
        console.warn(
          `Warning: ${blockedDependentCount} item(s) depend on this item and will remain blocked.`,
        );
      }
      if (item.recurrence) {
        console.log(`Cancelled: ${item.title} (recurrence stopped)`);
      } else {
        console.log(`Cancelled: ${item.title}`);
      }
    }
  } catch (err) {
    console.error((err as Error).message);
    process.exit(1);
  }
}
