import type { ParsedArgs } from "../cli.ts";
import { requirePositional } from "../command-flags.ts";
import type { CommandResult } from "../command-result.ts";
import { isCommandError, unwrapOrError } from "../result.ts";
import type { Item } from "../store.ts";
import { cancelItem } from "../store.ts";

export async function cancelCommand(parsed: ParsedArgs): Promise<CommandResult<Item>> {
  const idArg = requirePositional(parsed, 0, "Usage: hopper cancel <item-id>");
  if (!idArg.ok) return idArg.error;

  const outcome = unwrapOrError(await cancelItem(idArg.value));
  if (isCommandError(outcome)) return outcome;
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
}
