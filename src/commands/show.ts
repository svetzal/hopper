import type { ParsedArgs } from "../cli.ts";
import { findItem } from "../store.ts";
import { shortId } from "../format.ts";

export async function showCommand(parsed: ParsedArgs): Promise<void> {
  const id = parsed.positional[0];
  if (!id) {
    console.error("Usage: hopper show <id>");
    process.exit(1);
  }

  try {
    const item = await findItem(id);

    if (parsed.flags.json === true) {
      console.log(JSON.stringify(item, null, 2));
      return;
    }

    console.log(`ID:          ${shortId(item.id)}`);
    console.log(`Title:       ${item.title}`);
    console.log(`Status:      ${item.status}`);
    console.log(`Created:     ${item.createdAt}`);
    if (item.claimedAt) console.log(`Claimed:     ${item.claimedAt}`);
    if (item.claimedBy) console.log(`Claimed by:  ${item.claimedBy}`);
    if (item.completedAt) console.log(`Completed:   ${item.completedAt}`);
    if (item.completedBy) console.log(`Completed by: ${item.completedBy}`);
    if (item.workingDir) console.log(`Directory:   ${item.workingDir}`);
    if (item.requeueReason) console.log(`Requeue reason: ${item.requeueReason}`);
    if (item.requeuedBy) console.log(`Requeued by: ${item.requeuedBy}`);
    console.log();
    console.log(`Description:`);
    console.log(`  ${item.description}`);
    if (item.result) {
      console.log();
      console.log(`Result:`);
      console.log(`  ${item.result}`);
    }
  } catch (err) {
    console.error((err as Error).message);
    process.exit(1);
  }
}
