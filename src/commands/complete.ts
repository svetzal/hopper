import type { ParsedArgs } from "../cli.ts";
import { stringFlag } from "../command-flags.ts";
import type { CommandResult } from "../command-result.ts";
import { formatDuration } from "../format.ts";
import { completeItem } from "../store.ts";
import { withStoreError } from "./with-store-error.ts";

export async function completeCommand(parsed: ParsedArgs): Promise<CommandResult> {
  const token = parsed.positional[0];
  if (!token) {
    return { status: "error", message: "Usage: hopper complete <token>" };
  }

  const agent = stringFlag(parsed, "agent");
  const result = stringFlag(parsed, "result");

  return withStoreError(async () => {
    const { completed: item, recurred } = await completeItem(token, agent, result);

    const duration =
      item.claimedAt && item.completedAt
        ? formatDuration(item.claimedAt, item.completedAt)
        : "unknown";

    const lines = [`Completed: ${item.title} (${duration})`];
    if (recurred) {
      lines.push(
        `Re-queued: ${item.title} (next run: ${recurred.scheduledAt ? new Date(recurred.scheduledAt).toLocaleString() : "unknown"})`,
      );
    }

    return {
      status: "success",
      data: { completed: item, ...(recurred ? { recurred } : {}) },
      humanOutput: lines.join("\n"),
    };
  });
}
