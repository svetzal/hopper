import type { ParsedArgs } from "../cli.ts";
import { requirePositional } from "../command-flags.ts";
import type { CommandResult } from "../command-result.ts";
import { formatItemDetail } from "../format.ts";
import { findItem } from "../store.ts";
import { withStoreError } from "./with-store-error.ts";

export async function showCommand(parsed: ParsedArgs): Promise<CommandResult> {
  const idArg = requirePositional(parsed, 0, "Usage: hopper show <id>");
  if (!idArg.ok) return idArg.error;

  return withStoreError(async () => {
    const item = await findItem(idArg.value);
    return {
      status: "success",
      data: item,
      humanOutput: formatItemDetail(item),
    };
  });
}
