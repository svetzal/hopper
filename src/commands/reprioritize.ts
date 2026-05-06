import type { ParsedArgs } from "../cli.ts";
import { requirePositional } from "../command-flags.ts";
import type { CommandResult } from "../command-result.ts";
import { shortId } from "../format.ts";
import { parsePriority } from "../priority.ts";
import type { Item } from "../store.ts";
import { reprioritizeItem } from "../store.ts";

export async function reprioritizeCommand(parsed: ParsedArgs): Promise<CommandResult<Item>> {
  const USAGE = "Usage: hopper reprioritize <id> <high|normal|low>";
  const idArg = requirePositional(parsed, 0, USAGE);
  if (!idArg.ok) return idArg.error;

  const levelArg = requirePositional(parsed, 1, USAGE);
  if (!levelArg.ok) return levelArg.error;

  const priorityResult = parsePriority(levelArg.value);
  if (!priorityResult.ok) {
    return { status: "error", message: priorityResult.error };
  }

  const outcome = await reprioritizeItem(idArg.value, priorityResult.value);
  if (!outcome.ok) return { status: "error", message: outcome.error };
  const { item, oldPriority } = outcome.value;
  return {
    status: "success",
    data: item,
    humanOutput: `Reprioritized ${shortId(item.id)}: ${oldPriority} \u2192 ${priorityResult.value}`,
  };
}
