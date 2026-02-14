import type { ParsedArgs } from "../cli.ts";
import { requeueItem } from "../store.ts";

export async function requeueCommand(parsed: ParsedArgs): Promise<void> {
  const id = parsed.positional[0];
  if (!id) {
    console.error("Usage: hopper requeue <id> --reason \"...\"");
    process.exit(1);
  }

  const reason = parsed.flags.reason;
  if (typeof reason !== "string" || !reason) {
    console.error("--reason is required");
    process.exit(1);
  }

  const agent = typeof parsed.flags.agent === "string" ? parsed.flags.agent : undefined;

  try {
    const item = await requeueItem(id, reason, agent);

    if (parsed.flags.json === true) {
      console.log(JSON.stringify(item, null, 2));
    } else {
      console.log(`Requeued: ${item.title}`);
    }
  } catch (err) {
    console.error((err as Error).message);
    process.exit(1);
  }
}
