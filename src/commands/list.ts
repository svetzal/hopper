import type { ParsedArgs } from "../cli.ts";
import { stringFlag } from "../command-flags.ts";
import type { CommandResult } from "../command-result.ts";
import { filterAndSortItems, formatItemList } from "../list-workflow.ts";
import { loadItems } from "../store.ts";

export async function listCommand(parsed: ParsedArgs): Promise<CommandResult> {
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

  const filterResult = filterAndSortItems(allItems, filter, priorityFilter, tagFilter);
  if (!filterResult.ok) {
    return { status: "error", message: filterResult.error };
  }

  const { items } = filterResult;

  return {
    status: "success",
    data: items,
    humanOutput: formatItemList(items),
  };
}
