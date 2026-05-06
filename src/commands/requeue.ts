import type { ParsedArgs } from "../cli.ts";
import { requirePositional, stringFlag } from "../command-flags.ts";
import type { CommandResult } from "../command-result.ts";
import { requeueItem } from "../store.ts";

export async function requeueCommand(parsed: ParsedArgs): Promise<CommandResult> {
  const idArg = requirePositional(parsed, 0, 'Usage: hopper requeue <id> --reason "..."');
  if (!idArg.ok) return idArg.error;

  const reason = parsed.flags.reason;
  if (typeof reason !== "string" || !reason) {
    return { status: "error", message: "--reason is required" };
  }

  const agent = stringFlag(parsed, "agent");

  const outcome = await requeueItem(idArg.value, reason, agent);
  if (!outcome.ok) return { status: "error", message: outcome.error };
  return {
    status: "success",
    data: outcome.value,
    humanOutput: `Requeued: ${outcome.value.title}`,
  };
}
