import type { ParsedArgs } from "../cli.ts";
import { stringFlag, unwrapPositional } from "../command-flags.ts";
import type { CommandResult } from "../command-result.ts";
import { shortId } from "../format.ts";
import { parsePriority } from "../priority.ts";
import { catchCommandError, unwrap } from "../result.ts";
import type { Item } from "../store.ts";
import { reprioritizeItem } from "../store.ts";

const USAGE = "Usage: hopper edit <id> --priority <high|normal|low>";

export function editCommand(parsed: ParsedArgs): Promise<CommandResult<Item>> {
  return catchCommandError(async () => {
    const id = unwrapPositional(parsed, 0, USAGE);
    const level = stringFlag(parsed, "priority");
    if (!level) {
      return { status: "error", message: USAGE };
    }
    const priority = unwrap(parsePriority(level));
    const outcome = unwrap(await reprioritizeItem(id, priority));
    const { item, oldPriority } = outcome;
    return {
      status: "success",
      data: item,
      humanOutput: `Edited ${shortId(item.id)}: priority ${oldPriority} → ${priority}`,
    };
  });
}
