/**
 * Craftsperson (agent) resolution.
 *
 * Pure functions for discovering Claude Code agents, detecting project
 * markers, and building / parsing the Haiku prompt that picks the best-fitting
 * agent for a given engineering task. I/O lives in `agents-gateway.ts` and the
 * Haiku call itself lives in `claude-gateway.ts#generateText`.
 */

export interface AgentCandidate {
  /** Frontmatter `name` field from the `.md` file. */
  name: string;
  /** Frontmatter `description` field (may be multi-line). */
  description: string;
  /** Where the agent file came from. Local shadows global on name collision. */
  source: "local" | "global";
}

/**
 * Parse YAML frontmatter from an agent `.md` file.
 *
 * Extremely forgiving — we only need `name` and `description`. Multi-line
 * descriptions (folded or literal block scalars) are flattened to a single
 * line by joining non-empty continuation lines with spaces. Returns `null` if
 * either field is missing or the frontmatter block cannot be located.
 */
export function parseAgentFrontmatter(
  contents: string,
): { name: string; description: string } | null {
  const match = contents.match(/^---\s*\n([\s\S]*?)\n---\s*\n?/);
  if (!match) return null;
  const block = match[1] ?? "";
  const lines = block.split("\n");

  let name: string | undefined;
  let description: string | undefined;
  let i = 0;

  while (i < lines.length) {
    const line = lines[i] ?? "";
    const header = line.match(/^([A-Za-z_][A-Za-z0-9_-]*):\s*(.*)$/);
    if (!header) {
      i++;
      continue;
    }
    const key = header[1];
    let value = (header[2] ?? "").trim();

    // YAML block scalar for multi-line strings.
    if (value === "|" || value === ">") {
      const folded = value === ">";
      value = "";
      i++;
      const indent = (lines[i] ?? "").match(/^\s*/)?.[0].length ?? 0;
      if (indent === 0) continue;
      const contParts: string[] = [];
      while (i < lines.length) {
        const cur = lines[i] ?? "";
        if (cur.trim() === "") {
          contParts.push("");
          i++;
          continue;
        }
        const curIndent = cur.match(/^\s*/)?.[0].length ?? 0;
        if (curIndent < indent) break;
        contParts.push(cur.slice(indent));
        i++;
      }
      value = folded
        ? contParts.filter((s) => s.length > 0).join(" ")
        : contParts.join("\n").trim();
    } else {
      // Strip matching outer quotes if present.
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }
      i++;
    }

    if (key === "name") name = value;
    else if (key === "description") description = value;
  }

  if (!name || !description) return null;
  return { name, description };
}

/**
 * Merge discovered global + local agent lists. Local entries shadow global
 * entries with the same `name`.
 */
export function mergeAgentCandidates(
  global: AgentCandidate[],
  local: AgentCandidate[],
): AgentCandidate[] {
  const merged = new Map<string, AgentCandidate>();
  for (const g of global) merged.set(g.name, g);
  for (const l of local) merged.set(l.name, l);
  return [...merged.values()];
}

// ---------------------------------------------------------------------------
// Project marker detection
// ---------------------------------------------------------------------------

/**
 * Canonical list of project markers Haiku uses to pick a craftsperson.
 *
 * Keep the list tight — every marker has to be inexpensive to check and
 * meaningful to a selection decision. Language/runtime markers only; not
 * generic "has a README" noise.
 */
export const PROJECT_MARKERS: readonly string[] = [
  "pyproject.toml",
  "uv.lock",
  "requirements.txt",
  "Pipfile",
  "package.json",
  "bun.lockb",
  "bun.lock",
  "tsconfig.json",
  "deno.json",
  "Cargo.toml",
  "go.mod",
  "mix.exs",
  "Gemfile",
  "Package.swift",
  "CMakeLists.txt",
  "deps.edn",
  "project.clj",
  "pom.xml",
  "build.gradle",
  "build.gradle.kts",
  "settings.gradle.kts",
  "Podfile",
];

/**
 * Return the subset of well-known project markers that are present in the
 * given file-existence map. The map is deliberately simple (string → boolean)
 * so callers supply whatever probe results fit their environment.
 */
export function detectProjectMarkers(files: Record<string, boolean>): string[] {
  return PROJECT_MARKERS.filter((marker) => files[marker]);
}

// ---------------------------------------------------------------------------
// Selection prompt / response
// ---------------------------------------------------------------------------

/**
 * Build the Haiku selection prompt.
 *
 * We keep it terse on purpose — Haiku is cheap but bounded, so we want every
 * token to earn its place. Candidate descriptions are truncated to avoid the
 * prompt ballooning when there are a lot of agents installed globally.
 */
export function buildSelectionPrompt(
  title: string,
  description: string,
  markers: string[],
  candidates: AgentCandidate[],
): string {
  const markerLine = markers.length > 0 ? markers.join(", ") : "(none detected)";
  const lines: string[] = [
    "Pick the best-fitting agent for this coding task. Respond with JSON ONLY:",
    '{"agent": "<name>"} or {"agent": null} if nothing fits well.',
    "",
    `Project markers: ${markerLine}`,
    `Task title: ${title}`,
    `Task description: ${description}`,
    "",
    "Candidates:",
  ];
  for (const c of candidates) {
    const desc = c.description.length > 200 ? `${c.description.slice(0, 200)}…` : c.description;
    lines.push(`- ${c.name}: ${desc}`);
  }
  return lines.join("\n");
}

/**
 * Parse the Haiku response into a candidate name (or null).
 *
 * We look for a JSON object with shape `{ "agent": string | null }`. If the
 * response includes surrounding text (common despite "JSON ONLY" instructions)
 * we try to pull the first JSON object out of it. If the returned name is not
 * in the provided candidate set, we return `null` — better no agent than a
 * fabricated one.
 */
export function parseSelectionResponse(raw: string, candidates: AgentCandidate[]): string | null {
  const text = raw.trim();
  if (!text) return null;

  const jsonText = extractJsonObject(text);
  if (!jsonText) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch {
    return null;
  }

  if (typeof parsed !== "object" || parsed === null) return null;
  const agent = (parsed as { agent?: unknown }).agent;
  if (agent === null) return null;
  if (typeof agent !== "string") return null;

  const match = candidates.find((c) => c.name === agent);
  return match ? match.name : null;
}

function extractJsonObject(text: string): string | null {
  // Fast path: the whole string is a JSON object already.
  if (text.startsWith("{") && text.endsWith("}")) return text;

  // Fallback: grab the first balanced { ... } substring. Good enough for the
  // "model preambled with an explanation" case without reaching for a parser.
  const start = text.indexOf("{");
  if (start < 0) return null;
  let depth = 0;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}
