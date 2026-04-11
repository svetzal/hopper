import type { ParsedArgs } from "../cli.ts";
import { requirePositional, stringFlag } from "../command-flags.ts";
import type { CommandResult } from "../command-result.ts";
import { requeueItem } from "../store.ts";
import { withStoreError } from "./with-store-error.ts";

export async function requeueCommand(parsed: ParsedArgs): Promise<CommandResult> {
  const idArg = requirePositional(parsed, 0, 'Usage: hopper requeue <id> --reason "..."');
  if (!idArg.ok) return idArg.result;

  const reason = parsed.flags.reason;
  if (typeof reason !== "string" || !reason) {
    return { status: "error", message: "--reason is required" };
  }

  const agent = stringFlag(parsed, "agent");

  return withStoreError(async () => {
    const item = await requeueItem(idArg.value, reason, agent);
    return {
      status: "success",
      data: item,
      humanOutput: `Requeued: ${item.title}`,
    };
  });
}
