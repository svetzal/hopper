import type { ParsedArgs } from "../cli.ts";
import { claimNextItem } from "../store.ts";

export async function claimCommand(parsed: ParsedArgs): Promise<void> {
  const agent = typeof parsed.flags.agent === "string" ? parsed.flags.agent : undefined;

  const item = await claimNextItem(agent);

  if (!item) {
    console.error("No queued items available.");
    process.exit(1);
  }

  if (parsed.flags.json === true) {
    console.log(JSON.stringify(item, null, 2));
  } else {
    console.log(`Claimed: ${item.title}`);
    console.log(`Token:   ${item.claimToken}`);
  }
}
