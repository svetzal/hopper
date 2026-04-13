import type { ParsedArgs } from "../cli.ts";
import { stringFlag } from "../command-flags.ts";
import type { CommandResult } from "../command-result.ts";
import { claimNextItem } from "../store.ts";
import { withStoreError } from "./with-store-error.ts";

export async function claimCommand(parsed: ParsedArgs): Promise<CommandResult> {
  const agent = stringFlag(parsed, "agent");

  return withStoreError(async () => {
    const item = await claimNextItem(agent);

    if (!item) {
      return { status: "error", message: "No queued items available." };
    }

    return {
      status: "success",
      data: item,
      humanOutput: `Claimed: ${item.title}\nToken:   ${item.claimToken}`,
    };
  });
}
