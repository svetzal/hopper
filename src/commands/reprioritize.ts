import type { ParsedArgs } from "../cli.ts";
import { requirePositional } from "../command-flags.ts";
import type { CommandResult } from "../command-result.ts";
import { shortId } from "../format.ts";
import { safeParsePriority } from "../priority.ts";
import { reprioritizeItem } from "../store.ts";
import { withStoreError } from "./with-store-error.ts";

export async function reprioritizeCommand(parsed: ParsedArgs): Promise<CommandResult> {
  const USAGE = "Usage: hopper reprioritize <id> <high|normal|low>";
  const idArg = requirePositional(parsed, 0, USAGE);
  if (!idArg.ok) return idArg.result;

  const levelArg = requirePositional(parsed, 1, USAGE);
  if (!levelArg.ok) return levelArg.result;

  const priorityResult = safeParsePriority(levelArg.value);
  if (!priorityResult.ok) {
    return { status: "error", message: priorityResult.message };
  }

  return withStoreError(async () => {
    const { item, oldPriority } = await reprioritizeItem(idArg.value, priorityResult.priority);
    return {
      status: "success",
      data: item,
      humanOutput: `Reprioritized ${shortId(item.id)}: ${oldPriority} \u2192 ${priorityResult.priority}`,
    };
  });
}
