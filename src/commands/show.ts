import type { ParsedArgs } from "../cli.ts";
import { requirePositional } from "../command-flags.ts";
import type { CommandResult } from "../command-result.ts";
import { formatItemDetail } from "../format.ts";
import type { Item } from "../store.ts";
import { findItem } from "../store.ts";

export async function showCommand(parsed: ParsedArgs): Promise<CommandResult<Item>> {
  const idArg = requirePositional(parsed, 0, "Usage: hopper show <id>");
  if (!idArg.ok) return idArg.error;

  const outcome = await findItem(idArg.value);
  if (!outcome.ok) return { status: "error", message: outcome.error };
  return {
    status: "success",
    data: outcome.value,
    humanOutput: formatItemDetail(outcome.value),
  };
}
