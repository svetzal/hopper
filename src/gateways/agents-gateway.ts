import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { type AgentCandidate, parseAgentFrontmatter } from "../craftsperson-resolver.ts";

/**
 * Thin I/O wrapper around `~/.claude/agents/` and `<project>/.claude/agents/`.
 *
 * Reads `*.md` files, parses YAML frontmatter for `name` + `description`, and
 * returns them as candidates with a `source` marker. All business logic
 * (merging, selection, prompt building) lives in `craftsperson-resolver.ts`.
 */
export interface AgentsGateway {
  discoverAgents(globalAgentsDir: string, localAgentsDir: string): Promise<AgentCandidate[]>;
  /**
   * Cheap file-existence probe for a handful of project-marker filenames.
   * Returns a map `filename → present` suitable for
   * `detectProjectMarkers(files)`.
   */
  probeProjectMarkers(
    projectDir: string,
    markers: readonly string[],
  ): Promise<Record<string, boolean>>;
}

async function readAgentDir(dir: string, source: "local" | "global"): Promise<AgentCandidate[]> {
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return [];
  }
  const candidates: AgentCandidate[] = [];
  for (const entry of entries) {
    if (!entry.endsWith(".md")) continue;
    const path = join(dir, entry);
    let contents: string;
    try {
      contents = await Bun.file(path).text();
    } catch {
      continue;
    }
    const parsed = parseAgentFrontmatter(contents);
    if (!parsed) continue;
    candidates.push({ name: parsed.name, description: parsed.description, source });
  }
  return candidates;
}

async function discoverAgents(
  globalAgentsDir: string,
  localAgentsDir: string,
): Promise<AgentCandidate[]> {
  const [globalAgents, localAgents] = await Promise.all([
    readAgentDir(globalAgentsDir, "global"),
    readAgentDir(localAgentsDir, "local"),
  ]);
  // Local shadows global by name — merge here rather than forcing callers to
  // know the layering rule.
  const merged = new Map<string, AgentCandidate>();
  for (const g of globalAgents) merged.set(g.name, g);
  for (const l of localAgents) merged.set(l.name, l);
  return [...merged.values()];
}

async function probeProjectMarkers(
  projectDir: string,
  markers: readonly string[],
): Promise<Record<string, boolean>> {
  const results: Record<string, boolean> = {};
  await Promise.all(
    markers.map(async (marker) => {
      const path = join(projectDir, marker);
      results[marker] = await Bun.file(path).exists();
    }),
  );
  return results;
}

export function createAgentsGateway(): AgentsGateway {
  return { discoverAgents, probeProjectMarkers };
}
