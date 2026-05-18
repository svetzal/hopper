import { homedir } from "node:os";
import { join } from "node:path";
import {
  buildSelectionPrompt,
  detectProjectMarkers,
  PROJECT_MARKERS,
  parseSelectionResponse,
} from "../craftsperson-resolver.ts";
import type { AgentRunner } from "../gateways/agent-runner.ts";
import type { AgentsGateway } from "../gateways/agents-gateway.ts";
import type { AgentResolver } from "./add.ts";

/**
 * Wire up the production agent resolver used by `hopper add` when no
 * `--agent` is specified for an engineering item.
 *
 * The resolver discovers candidates from the user's global + project-local
 * agents directories, probes project markers, and asks the profile's fast
 * tier to pick the best-fitting craftsperson. The runner is the routing
 * runner — the call lands on whichever underlying gateway the profile
 * names. Any failure along the way (no agents installed, generateText
 * errored, JSON parse failed, returned name not in candidate set) returns
 * `null` — the item is enqueued without an agent and the worker runs the
 * runner's default.
 */
export function createAgentResolver(agents: AgentsGateway, runner: AgentRunner): AgentResolver {
  const globalAgentsDir = join(homedir(), ".claude", "agents");

  return async ({ title, description, workingDir, profile }) => {
    try {
      const localAgentsDir = join(workingDir, ".claude", "agents");
      const candidates = await agents.discoverAgents(globalAgentsDir, localAgentsDir);
      if (candidates.length === 0) return null;

      const fileMap = await agents.probeProjectMarkers(workingDir, PROJECT_MARKERS);
      const markers = detectProjectMarkers(fileMap);

      const prompt = buildSelectionPrompt(title, description, markers, candidates);
      const { exitCode, text } = await runner.generateText(prompt, "fast", { profile });
      if (exitCode !== 0) return null;

      return parseSelectionResponse(text, candidates);
    } catch {
      return null;
    }
  };
}
