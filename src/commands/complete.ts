import type { ParsedArgs } from "../cli.ts";
import { formatDuration } from "../format.ts";
import { completeItem } from "../store.ts";

export async function completeCommand(parsed: ParsedArgs): Promise<void> {
  const token = parsed.positional[0];
  if (!token) {
    console.error("Usage: hopper complete <token>");
    process.exit(1);
  }

  const agent = typeof parsed.flags.agent === "string" ? parsed.flags.agent : undefined;
  const result = typeof parsed.flags.result === "string" ? parsed.flags.result : undefined;

  try {
    const { completed: item, recurred } = await completeItem(token, agent, result);

    if (parsed.flags.json === true) {
      console.log(JSON.stringify({ completed: item, ...(recurred ? { recurred } : {}) }, null, 2));
    } else {
      const duration =
        item.claimedAt && item.completedAt
          ? formatDuration(item.claimedAt, item.completedAt)
          : "unknown";
      console.log(`Completed: ${item.title} (${duration})`);
      if (recurred) {
        console.log(
          `Re-queued: ${item.title} (next run: ${recurred.scheduledAt ? new Date(recurred.scheduledAt).toLocaleString() : "unknown"})`,
        );
      }
    }
  } catch (err) {
    console.error((err as Error).message);
    process.exit(1);
  }
}
