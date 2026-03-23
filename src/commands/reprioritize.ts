import type { ParsedArgs } from "../cli.ts";
import { shortId } from "../format.ts";
import type { Priority } from "../priority.ts";
import { parsePriority } from "../priority.ts";
import { reprioritizeItem } from "../store.ts";

export async function reprioritizeCommand(parsed: ParsedArgs): Promise<void> {
  const id = parsed.positional[0];
  const levelArg = parsed.positional[1];

  if (!id || !levelArg) {
    console.error("Usage: hopper reprioritize <id> <high|normal|low>");
    process.exit(1);
  }

  let priority: Priority | undefined;
  try {
    priority = parsePriority(levelArg);
  } catch (e) {
    console.error((e as Error).message);
    process.exit(1);
  }

  try {
    const { item, oldPriority } = await reprioritizeItem(id, priority);

    if (parsed.flags.json === true) {
      console.log(JSON.stringify(item, null, 2));
    } else {
      console.log(`Reprioritized ${shortId(item.id)}: ${oldPriority} \u2192 ${priority}`);
    }
  } catch (e) {
    console.error((e as Error).message);
    process.exit(1);
  }
}
