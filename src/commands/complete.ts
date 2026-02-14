import type { ParsedArgs } from "../cli.ts";
import { completeItem } from "../store.ts";
import { formatDuration } from "../format.ts";

export async function completeCommand(parsed: ParsedArgs): Promise<void> {
  const token = parsed.positional[0];
  if (!token) {
    console.error("Usage: hopper complete <token>");
    process.exit(1);
  }

  const agent = typeof parsed.flags.agent === "string" ? parsed.flags.agent : undefined;

  try {
    const item = await completeItem(token, agent);

    if (parsed.flags.json === true) {
      console.log(JSON.stringify(item, null, 2));
    } else {
      const duration =
        item.claimedAt && item.completedAt
          ? formatDuration(item.claimedAt, item.completedAt)
          : "unknown";
      console.log(`Completed: ${item.title} (${duration})`);
    }
  } catch (err) {
    console.error((err as Error).message);
    process.exit(1);
  }
}
