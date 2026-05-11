import type { ParsedArgs } from "../cli.ts";
import { requirePositional, stringFlag } from "../command-flags.ts";
import type { CommandResult } from "../command-result.ts";
import { isCommandError, unwrapOrError } from "../result.ts";
import type { Item } from "../store.ts";
import { requeueItem } from "../store.ts";

export async function requeueCommand(parsed: ParsedArgs): Promise<CommandResult<Item>> {
  const idArg = requirePositional(parsed, 0, 'Usage: hopper requeue <id> --reason "..."');
  if (!idArg.ok) return idArg.error;

  const reason = parsed.flags.reason;
  if (typeof reason !== "string" || !reason) {
    return { status: "error", message: "--reason is required" };
  }

  const agent = stringFlag(parsed, "agent");

  const item = unwrapOrError(await requeueItem(idArg.value, reason, agent));
  if (isCommandError(item)) return item;
  return {
    status: "success",
    data: item,
    humanOutput: `Requeued: ${item.title}`,
  };
}
