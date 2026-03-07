import type { ParsedArgs } from "../cli.ts";
import { updateItemTags, removeItemTags } from "../store.ts";
import { normalizeTag } from "../tags.ts";
import { shortId } from "../format.ts";

export async function tagCommand(parsed: ParsedArgs): Promise<void> {
  const id = parsed.positional[0];
  const rawTags = parsed.positional.slice(1);

  if (!id || rawTags.length === 0) {
    console.error("Usage: hopper tag <id> <tag> [<tag>...]");
    process.exit(1);
  }

  let tags: string[];
  try {
    tags = rawTags.map(normalizeTag);
  } catch (e) {
    console.error((e as Error).message);
    process.exit(1);
  }

  try {
    const item = await updateItemTags(id, tags);
    if (parsed.flags.json === true) {
      console.log(JSON.stringify(item, null, 2));
    } else {
      console.log(`Tagged ${shortId(item.id)}: ${tags.join(", ")}`);
    }
  } catch (err) {
    console.error((err as Error).message);
    process.exit(1);
  }
}

export async function untagCommand(parsed: ParsedArgs): Promise<void> {
  const id = parsed.positional[0];
  const rawTags = parsed.positional.slice(1);

  if (!id || rawTags.length === 0) {
    console.error("Usage: hopper untag <id> <tag> [<tag>...]");
    process.exit(1);
  }

  let tags: string[];
  try {
    tags = rawTags.map(normalizeTag);
  } catch (e) {
    console.error((e as Error).message);
    process.exit(1);
  }

  try {
    const item = await removeItemTags(id, tags);
    if (parsed.flags.json === true) {
      console.log(JSON.stringify(item, null, 2));
    } else {
      console.log(`Untagged ${shortId(item.id)}: ${tags.join(", ")}`);
    }
  } catch (err) {
    console.error((err as Error).message);
    process.exit(1);
  }
}
