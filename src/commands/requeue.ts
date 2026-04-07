import type { ParsedArgs } from "../cli.ts";
import { stringFlag } from "../command-flags.ts";
import type { CommandResult } from "../command-result.ts";
import { requeueItem } from "../store.ts";
import { withStoreError } from "./with-store-error.ts";

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

  return withStoreError(async () => {
    const item = await requeueItem(id, reason, agent);
    return {
      status: "success",
      data: item,
      humanOutput: `Requeued: ${item.title}`,
    };
  });
}
