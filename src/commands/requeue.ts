import type { ParsedArgs } from "../cli.ts";
import { stringFlag, unwrapPositional } from "../command-flags.ts";
import type { CommandResult } from "../command-result.ts";
import { catchCommandError, unwrap } from "../result.ts";
import type { Item } from "../store.ts";
import { requeueItem } from "../store.ts";

export function requeueCommand(parsed: ParsedArgs): Promise<CommandResult<Item>> {
  return catchCommandError(async () => {
    const id = unwrapPositional(parsed, 0, 'Usage: hopper requeue <id> --reason "..."');

    const reason = parsed.flags.reason;
    if (typeof reason !== "string" || !reason) {
      return { status: "error", message: "--reason is required" };
    }

    const agent = stringFlag(parsed, "agent");
    const item = unwrap(await requeueItem(id, reason, agent));
    return {
      status: "success",
      data: item,
      humanOutput: `Requeued: ${item.title}`,
    };
  });
}
