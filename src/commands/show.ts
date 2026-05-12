import type { ParsedArgs } from "../cli.ts";
import { unwrapPositional } from "../command-flags.ts";
import type { CommandResult } from "../command-result.ts";
import { formatItemDetail } from "../format.ts";
import { catchCommandError, unwrap } from "../result.ts";
import type { Item } from "../store.ts";
import { findItem } from "../store.ts";

export function showCommand(parsed: ParsedArgs): Promise<CommandResult<Item>> {
  return catchCommandError(async () => {
    const id = unwrapPositional(parsed, 0, "Usage: hopper show <id>");
    const item = unwrap(await findItem(id));
    return {
      status: "success",
      data: item,
      humanOutput: formatItemDetail(item),
    };
  });
}
