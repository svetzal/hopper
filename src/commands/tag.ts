import type { ParsedArgs } from "../cli.ts";
import { requirePositional } from "../command-flags.ts";
import type { CommandResult } from "../command-result.ts";
import { shortId } from "../format.ts";
import { isCommandError, unwrapOrError } from "../result.ts";
import type { Result } from "../result.ts";
import type { Item } from "../store.ts";
import { removeItemTags, updateItemTags } from "../store.ts";
import { normalizeTags } from "../tags.ts";

async function tagAction(
  parsed: ParsedArgs,
  usage: string,
  storeFn: (id: string, tags: string[]) => Promise<Result<Item>>,
  verb: string,
): Promise<CommandResult<Item>> {
  const idArg = requirePositional(parsed, 0, usage);
  if (!idArg.ok) return idArg.error;

  const rawTags = parsed.positional.slice(1);
  if (rawTags.length === 0) {
    return { status: "error", message: usage };
  }

  const tags = unwrapOrError(normalizeTags(rawTags));
  if (isCommandError(tags)) return tags;

  const item = unwrapOrError(await storeFn(idArg.value, tags));
  if (isCommandError(item)) return item;
  return {
    status: "success",
    data: item,
    humanOutput: `${verb} ${shortId(item.id)}: ${tags.join(", ")}`,
  };
}

export function tagCommand(parsed: ParsedArgs): Promise<CommandResult<Item>> {
  return tagAction(parsed, "Usage: hopper tag <id> <tag> [<tag>...]", updateItemTags, "Tagged");
}

export function untagCommand(parsed: ParsedArgs): Promise<CommandResult<Item>> {
  return tagAction(parsed, "Usage: hopper untag <id> <tag> [<tag>...]", removeItemTags, "Untagged");
}
