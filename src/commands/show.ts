import type { ParsedArgs } from "../cli.ts";
import type { CommandResult } from "../command-result.ts";
import { toErrorMessage } from "../error-utils.ts";
import { formatItemDetail } from "../format.ts";
import { findItem } from "../store.ts";

export async function showCommand(parsed: ParsedArgs): Promise<CommandResult> {
  const id = parsed.positional[0];
  if (!id) {
    return { status: "error", message: "Usage: hopper show <id>" };
  }

  try {
    const item = await findItem(id);
    return {
      status: "success",
      data: item,
      humanOutput: formatItemDetail(item),
    };
  } catch (e) {
    return { status: "error", message: toErrorMessage(e) };
  }
}
