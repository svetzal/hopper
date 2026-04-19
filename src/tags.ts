import { err, ok, type Result } from "./result.ts";

const TAG_PATTERN = /^[a-z0-9_-]+$/;
const MAX_TAG_LENGTH = 32;

export function normalizeTag(input: string): Result<string> {
  const trimmed = input.trim().toLowerCase().replace(/\s+/g, "-");
  if (trimmed.length === 0) {
    return err("Tag cannot be empty.");
  }
  if (trimmed.length > MAX_TAG_LENGTH) {
    return err(`Invalid tag '${input}'. Tags must be ${MAX_TAG_LENGTH} characters or fewer.`);
  }
  if (!TAG_PATTERN.test(trimmed)) {
    return err(
      `Invalid tag '${input}'. Tags may contain letters, numbers, hyphens, and underscores.`,
    );
  }
  return ok(trimmed);
}

export function mergeTags(existing: string[], additions: string[]): string[] {
  const set = new Set([...existing, ...additions]);
  return [...set].sort();
}

export function matchesTags(itemTags: string[] | undefined, filter: string[]): boolean {
  if (!itemTags || itemTags.length === 0) return false;
  return filter.some((tag) => itemTags.includes(tag));
}

export function normalizeTags(raw: string[]): Result<string[]> {
  const values: string[] = [];
  for (const r of raw) {
    const result = normalizeTag(r);
    if (!result.ok) return result;
    values.push(result.value);
  }
  return ok(values);
}

export function tagBadge(tags: string[] | undefined): string {
  return tags?.length ? ` [${tags.join(", ")}]` : "";
}
