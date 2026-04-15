import type { ParsedArgs } from "../cli.ts";
import { requirePositional } from "../command-flags.ts";
import type { CommandResult } from "../command-result.ts";
import { shortId } from "../format.ts";
import type { Item } from "../store.ts";
import { removeItemTags, updateItemTags } from "../store.ts";
import { normalizeTags } from "../tags.ts";
import { withStoreError } from "./with-store-error.ts";

async function tagAction(
  parsed: ParsedArgs,
  usage: string,
  storeFn: (id: string, tags: string[]) => Promise<Item>,
  verb: string,
): Promise<CommandResult> {
  const idArg = requirePositional(parsed, 0, usage);
  if (!idArg.ok) return idArg.error;

  const rawTags = parsed.positional.slice(1);
  if (rawTags.length === 0) {
    return { status: "error", message: usage };
  }

  const tagResult = normalizeTags(rawTags);
  if (!tagResult.ok) return { status: "error", message: tagResult.error };
  const tags = tagResult.value;

  return withStoreError(async () => {
    const item = await storeFn(idArg.value, tags);
    return {
      status: "success",
      data: item,
      humanOutput: `${verb} ${shortId(item.id)}: ${tags.join(", ")}`,
    };
  });
}

export function tagCommand(parsed: ParsedArgs): Promise<CommandResult> {
  return tagAction(parsed, "Usage: hopper tag <id> <tag> [<tag>...]", updateItemTags, "Tagged");
}

export function untagCommand(parsed: ParsedArgs): Promise<CommandResult> {
  return tagAction(parsed, "Usage: hopper untag <id> <tag> [<tag>...]", removeItemTags, "Untagged");
}
