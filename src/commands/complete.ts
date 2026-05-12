import type { ParsedArgs } from "../cli.ts";
import { stringFlag, unwrapPositional } from "../command-flags.ts";
import type { CommandResult } from "../command-result.ts";
import { formatDuration } from "../format.ts";
import { catchCommandError, unwrap } from "../result.ts";
import type { CompleteResult } from "../store.ts";
import { completeItem } from "../store.ts";

export function completeCommand(parsed: ParsedArgs): Promise<CommandResult<CompleteResult>> {
  return catchCommandError(async () => {
    const token = unwrapPositional(parsed, 0, "Usage: hopper complete <token>");
    const agent = stringFlag(parsed, "agent");
    const result = stringFlag(parsed, "result");

    const outcome = unwrap(await completeItem(token, agent, result));
    const { completed: item, recurred } = outcome;

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
