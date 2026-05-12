import type { ParsedArgs } from "../cli.ts";
import { unwrapPositional } from "../command-flags.ts";
import type { CommandResult } from "../command-result.ts";
import { shortId } from "../format.ts";
import { parsePriority } from "../priority.ts";
import { catchCommandError, unwrap } from "../result.ts";
import type { Item } from "../store.ts";
import { reprioritizeItem } from "../store.ts";

export function reprioritizeCommand(parsed: ParsedArgs): Promise<CommandResult<Item>> {
  return catchCommandError(async () => {
    const USAGE = "Usage: hopper reprioritize <id> <high|normal|low>";
    const id = unwrapPositional(parsed, 0, USAGE);
    const level = unwrapPositional(parsed, 1, USAGE);
    const priority = unwrap(parsePriority(level));
    const outcome = unwrap(await reprioritizeItem(id, priority));
    const { item, oldPriority } = outcome;
    return {
      status: "success",
      data: item,
      humanOutput: `Reprioritized ${shortId(item.id)}: ${oldPriority} → ${priority}`,
    };
  });
}
