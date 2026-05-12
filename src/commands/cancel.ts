import type { ParsedArgs } from "../cli.ts";
import { unwrapPositional } from "../command-flags.ts";
import type { CommandResult } from "../command-result.ts";
import { catchCommandError, unwrap } from "../result.ts";
import type { Item } from "../store.ts";
import { cancelItem } from "../store.ts";

export function cancelCommand(parsed: ParsedArgs): Promise<CommandResult<Item>> {
  return catchCommandError(async () => {
    const id = unwrapPositional(parsed, 0, "Usage: hopper cancel <item-id>");
    const outcome = unwrap(await cancelItem(id));
    const { item, blockedDependentCount } = outcome;

    const warnings: string[] = [];
    if (blockedDependentCount > 0) {
      warnings.push(
        `Warning: ${blockedDependentCount} item(s) depend on this item and will remain blocked.`,
      );
    }

    const humanOutput = item.recurrence
      ? `Cancelled: ${item.title} (recurrence stopped)`
      : `Cancelled: ${item.title}`;

    return {
      status: "success",
      data: item,
      humanOutput,
      ...(warnings.length > 0 ? { warnings } : {}),
    };
  });
}
