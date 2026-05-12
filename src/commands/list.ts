import type { ParsedArgs } from "../cli.ts";
import { stringFlag } from "../command-flags.ts";
import type { CommandResult } from "../command-result.ts";
import { filterAndSortItems, formatItemList } from "../list-workflow.ts";
import { catchCommandError, unwrap } from "../result.ts";
import type { Item } from "../store.ts";
import { loadItems } from "../store.ts";

export function listCommand(parsed: ParsedArgs): Promise<CommandResult<Item[]>> {
  return catchCommandError(async () => {
    const allItems = await loadItems();

    const filter =
      parsed.flags.completed === true
        ? ({ mode: "completed" } as const)
        : parsed.flags.scheduled === true
          ? ({ mode: "scheduled" } as const)
          : parsed.flags.all === true
            ? ({ mode: "all" } as const)
            : ({ mode: "default" } as const);

    const priorityFilter = stringFlag(parsed, "priority");
    const tagFilter = parsed.arrayFlags.tag ?? [];
    const typeFilter = stringFlag(parsed, "type");

    const items = unwrap(
      filterAndSortItems(allItems, filter, priorityFilter, tagFilter, typeFilter),
    );

    return {
      status: "success",
      data: items,
      humanOutput: formatItemList(items),
    };
  });
}
