import type { ParsedArgs } from "../cli.ts";
import type { CommandResult } from "../command-result.ts";
import { shortId } from "../format.ts";
import { removeItemTags, updateItemTags } from "../store.ts";
import { normalizeTags } from "../tags.ts";

export async function tagCommand(parsed: ParsedArgs): Promise<CommandResult> {
  const id = parsed.positional[0];
  const rawTags = parsed.positional.slice(1);

  if (!id || rawTags.length === 0) {
    return { status: "error", message: "Usage: hopper tag <id> <tag> [<tag>...]" };
  }

  const tagResult = normalizeTags(rawTags);
  if (!tagResult.ok) return { status: "error", message: tagResult.error };
  const tags = tagResult.tags;

  const item = await updateItemTags(id, tags);

  return {
    status: "success",
    data: item,
    humanOutput: `Tagged ${shortId(item.id)}: ${tags.join(", ")}`,
  };
}

export async function untagCommand(parsed: ParsedArgs): Promise<CommandResult> {
  const id = parsed.positional[0];
  const rawTags = parsed.positional.slice(1);

  if (!id || rawTags.length === 0) {
    return { status: "error", message: "Usage: hopper untag <id> <tag> [<tag>...]" };
  }

  const tagResult = normalizeTags(rawTags);
  if (!tagResult.ok) return { status: "error", message: tagResult.error };
  const tags = tagResult.tags;

  const item = await removeItemTags(id, tags);

  return {
    status: "success",
    data: item,
    humanOutput: `Untagged ${shortId(item.id)}: ${tags.join(", ")}`,
  };
}
