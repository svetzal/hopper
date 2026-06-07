import { homedir } from "node:os";
import { join } from "node:path";
import { extractCraftspersonBody } from "../craftsperson-body.ts";

/**
 * Load the system-prompt body of a craftsperson agent file from the default
 * global location: `~/.claude/agents/<name>.md`.
 *
 * Mirror the same path layering as agents-gateway: global ~/.claude/agents
 * is the default; project-local paths are not resolved here.
 *
 * Returns the extracted body string, or null if the file is missing or unreadable.
 */
export async function loadCraftspersonBody(name: string): Promise<string | null> {
  const path = join(homedir(), ".claude", "agents", `${name}.md`);
  const file = Bun.file(path);
  if (!(await file.exists())) return null;
  const contents = await file.text().catch(() => null);
  if (contents == null) return null;
  return extractCraftspersonBody(contents);
}

/**
 * Resolve the craftsperson body for an agent session.
 *
 * Encapsulates the repeated `(deps.loadCraftsperson ?? loadCraftspersonBody)`
 * fallback and the `agent ? await loader(agent) : null` guard that was
 * previously duplicated across the opencode and codex gateway modules.
 *
 * Returns null when no agent is requested, without calling the loader.
 */
export async function resolveCraftspersonBody(
  loader: ((name: string) => Promise<string | null>) | undefined,
  agent: string | undefined,
): Promise<string | null> {
  if (!agent) return null;
  return (loader ?? loadCraftspersonBody)(agent);
}
