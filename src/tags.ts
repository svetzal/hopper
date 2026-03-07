const TAG_PATTERN = /^[a-z0-9_-]+$/;
const MAX_TAG_LENGTH = 32;

export function normalizeTag(input: string): string {
  const trimmed = input.trim().toLowerCase().replace(/\s+/g, "-");
  if (trimmed.length === 0) {
    throw new Error("Tag cannot be empty.");
  }
  if (trimmed.length > MAX_TAG_LENGTH) {
    throw new Error(`Invalid tag '${input}'. Tags must be ${MAX_TAG_LENGTH} characters or fewer.`);
  }
  if (!TAG_PATTERN.test(trimmed)) {
    throw new Error(`Invalid tag '${input}'. Tags may contain letters, numbers, hyphens, and underscores.`);
  }
  return trimmed;
}

export function mergeTags(existing: string[], additions: string[]): string[] {
  const set = new Set([...existing, ...additions]);
  return [...set].sort();
}

export function matchesTags(itemTags: string[] | undefined, filter: string[]): boolean {
  if (!itemTags || itemTags.length === 0) return false;
  return filter.some((tag) => itemTags.includes(tag));
}
