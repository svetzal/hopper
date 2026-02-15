import type { ParsedArgs } from "../cli.ts";
import { cancelItem } from "../store.ts";

export async function cancelCommand(parsed: ParsedArgs): Promise<void> {
  const id = parsed.positional[0];
  if (!id) {
    console.error("Usage: hopper cancel <item-id>");
    process.exit(1);
  }

  try {
    const item = await cancelItem(id);

    if (parsed.flags.json === true) {
      console.log(JSON.stringify(item, null, 2));
    } else {
      console.log(`Cancelled: ${item.title}`);
    }
  } catch (err) {
    console.error((err as Error).message);
    process.exit(1);
  }
}
