import { homedir } from "node:os";
import { join } from "node:path";
import {
  buildSelectionPrompt,
  detectProjectMarkers,
  PROJECT_MARKERS,
  parseSelectionResponse,
} from "../craftsperson-resolver.ts";
import type { AgentsGateway } from "../gateways/agents-gateway.ts";
import type { ClaudeGateway } from "../gateways/claude-gateway.ts";
import type { AgentResolver } from "./add.ts";

/**
 * Wire up the production agent resolver used by `hopper add` when no
 * `--agent` is specified for an engineering item.
 *
 * The resolver discovers candidates from the user's global + project-local
 * agents directories, probes project markers, and asks Haiku to pick the
 * best-fitting craftsperson. Any failure along the way (no agents installed,
 * Haiku call errored, JSON parse failed, returned name not in candidate set)
 * returns `null` — the item is enqueued without an agent and the worker runs
 * Claude's default.
 */
export function createAgentResolver(agents: AgentsGateway, claude: ClaudeGateway): AgentResolver {
  const globalAgentsDir = join(homedir(), ".claude", "agents");

  return async ({ title, description, workingDir }) => {
    try {
      const localAgentsDir = join(workingDir, ".claude", "agents");
      const candidates = await agents.discoverAgents(globalAgentsDir, localAgentsDir);
      if (candidates.length === 0) return null;

      const fileMap = await agents.probeProjectMarkers(workingDir, PROJECT_MARKERS);
      const markers = detectProjectMarkers(fileMap);

      const prompt = buildSelectionPrompt(title, description, markers, candidates);
      const { exitCode, text } = await claude.generateText(prompt, "haiku");
      if (exitCode !== 0) return null;

      return parseSelectionResponse(text, candidates);
    } catch {
      return null;
    }
  };
}
