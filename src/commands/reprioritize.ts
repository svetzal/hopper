import type { ParsedArgs } from "../cli.ts";
import { requirePositional } from "../command-flags.ts";
import type { CommandResult } from "../command-result.ts";
import { shortId } from "../format.ts";
import { parsePriority } from "../priority.ts";
import { isCommandError, unwrapOrError } from "../result.ts";
import type { Item } from "../store.ts";
import { reprioritizeItem } from "../store.ts";

export async function reprioritizeCommand(parsed: ParsedArgs): Promise<CommandResult<Item>> {
  const USAGE = "Usage: hopper reprioritize <id> <high|normal|low>";
  const idArg = requirePositional(parsed, 0, USAGE);
  if (!idArg.ok) return idArg.error;

  const levelArg = requirePositional(parsed, 1, USAGE);
  if (!levelArg.ok) return levelArg.error;

  const priority = unwrapOrError(parsePriority(levelArg.value));
  if (isCommandError(priority)) return priority;

  const outcome = unwrapOrError(await reprioritizeItem(idArg.value, priority));
  if (isCommandError(outcome)) return outcome;
  const { item, oldPriority } = outcome;
  return {
    status: "success",
    data: item,
    humanOutput: `Reprioritized ${shortId(item.id)}: ${oldPriority} \u2192 ${priority}`,
  };
}
