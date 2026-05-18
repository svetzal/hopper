/**
 * Extract the system-prompt body from a craftsperson `.md` file.
 *
 * Craftsperson files have YAML frontmatter (parsed elsewhere by
 * {@link import("./craftsperson-resolver.ts").parseAgentFrontmatter}) followed
 * by the agent's system prompt. When inlining a craftsperson into an
 * opencode session, hopper needs only the body — the frontmatter `name` and
 * `description` are metadata for selection, not for the agent itself.
 *
 * Returns the trimmed body, or the entire trimmed content if no closing
 * frontmatter delimiter is found (treats malformed files as "all body").
 */
export function extractCraftspersonBody(contents: string): string {
  const match = contents.match(/^---\s*\n[\s\S]*?\n---\s*\n?/);
  if (!match) return contents.trim();
  return contents.slice(match[0].length).trim();
}
