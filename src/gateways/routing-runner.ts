import type { Profile } from "../profile.ts";
import type { AgentRunner, SessionOptions } from "./agent-runner.ts";
import { createClaudeRunner } from "./claude-gateway.ts";
import { createOpencodeRunner } from "./opencode-gateway.ts";

/**
 * Profile-driven router. Wraps a claude runner and an opencode runner and
 * dispatches each call to whichever one the profile names — so the worker
 * (and any other caller) can hold a single {@link AgentRunner} and treat
 * runner selection as an internal concern of the profile system.
 *
 * Every call must carry `options.profile` (for runSession) or
 * `options.profile` (for generateText). Without a profile the router throws
 * — there is no implicit default at this layer because the worker resolves
 * the profile from `item.profile` and a missing profile is a programming
 * error in the caller.
 *
 * Optional `deps` lets tests substitute lightweight runners; production
 * callers pass nothing.
 */
export interface RoutingRunnerDeps {
  claude?: AgentRunner;
  opencode?: AgentRunner;
}

export function createRoutingRunner(deps: RoutingRunnerDeps = {}): AgentRunner {
  const claude = deps.claude ?? createClaudeRunner();
  const opencode = deps.opencode ?? createOpencodeRunner();

  function pick(profile: Profile | undefined, context: string): AgentRunner {
    if (!profile) {
      throw new Error(
        `Routing runner called without a profile (${context}); the caller must pass options.profile`,
      );
    }
    return profile.runner === "opencode" ? opencode : claude;
  }

  return {
    async runSession(prompt, cwd, auditFile, options: SessionOptions = {}) {
      return pick(options.profile, "runSession").runSession(prompt, cwd, auditFile, options);
    },
    async generateText(prompt, model, options) {
      return pick(options.profile, "generateText").generateText(prompt, model, options);
    },
  };
}
