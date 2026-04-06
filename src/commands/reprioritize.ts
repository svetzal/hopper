import type { ParsedArgs } from "../cli.ts";
import type { CommandResult } from "../command-result.ts";
import { toErrorMessage } from "../error-utils.ts";
import { shortId } from "../format.ts";
import type { Priority } from "../priority.ts";
import { parsePriority } from "../priority.ts";
import { reprioritizeItem } from "../store.ts";

export async function reprioritizeCommand(parsed: ParsedArgs): Promise<CommandResult> {
  const id = parsed.positional[0];
  const levelArg = parsed.positional[1];

  if (!id || !levelArg) {
    return { status: "error", message: "Usage: hopper reprioritize <id> <high|normal|low>" };
  }

  let priority: Priority;
  try {
    priority = parsePriority(levelArg);
  } catch (e) {
    return { status: "error", message: toErrorMessage(e) };
  }

  let item: Awaited<ReturnType<typeof reprioritizeItem>>["item"];
  let oldPriority: Awaited<ReturnType<typeof reprioritizeItem>>["oldPriority"];
  try {
    ({ item, oldPriority } = await reprioritizeItem(id, priority));
  } catch (e) {
    return { status: "error", message: toErrorMessage(e) };
  }

  return {
    status: "success",
    data: item,
    humanOutput: `Reprioritized ${shortId(item.id)}: ${oldPriority} \u2192 ${priority}`,
  };
}
