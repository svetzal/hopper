import type { ParsedArgs } from "../cli.ts";
import { stringFlag } from "../command-flags.ts";
import type { CommandResult } from "../command-result.ts";
import { toErrorMessage } from "../error-utils.ts";
import { requeueItem } from "../store.ts";

export async function requeueCommand(parsed: ParsedArgs): Promise<CommandResult> {
  const id = parsed.positional[0];
  if (!id) {
    return { status: "error", message: 'Usage: hopper requeue <id> --reason "..."' };
  }

  const reason = parsed.flags.reason;
  if (typeof reason !== "string" || !reason) {
    return { status: "error", message: "--reason is required" };
  }

  const agent = stringFlag(parsed, "agent");

  let item: Awaited<ReturnType<typeof requeueItem>>;
  try {
    item = await requeueItem(id, reason, agent);
  } catch (e) {
    return { status: "error", message: toErrorMessage(e) };
  }

  return {
    status: "success",
    data: item,
    humanOutput: `Requeued: ${item.title}`,
  };
}
