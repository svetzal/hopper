import { describe, expect, mock, test } from "bun:test";
import type { AgentCandidate } from "../craftsperson-resolver.ts";
import type { AgentsGateway } from "../gateways/agents-gateway.ts";
import type { ClaudeGateway } from "../gateways/claude-gateway.ts";
import { createAgentResolver } from "./add-agent-resolver.ts";

function makeAgentsGw(
  candidates: AgentCandidate[],
  markers: Record<string, boolean> = {},
): AgentsGateway {
  return {
    discoverAgents: mock(async () => candidates),
    probeProjectMarkers: mock(async () => markers),
  };
}

function makeClaudeGw(response: { exitCode: number; text: string }): ClaudeGateway {
  return {
    runSession: mock(async () => ({ exitCode: 0, result: "" })),
    generateText: mock(async () => response),
  };
}

const INPUT = {
  title: "Add --quiet flag",
  description: "Silence info logs.",
  workingDir: "/repo",
};

describe("createAgentResolver", () => {
  test("returns the picked agent when Haiku responds with a valid candidate", async () => {
    const candidates: AgentCandidate[] = [
      { name: "typescript-bun-cli-craftsperson", description: "Bun CLIs.", source: "global" },
      { name: "rust-craftsperson", description: "Rust.", source: "global" },
    ];
    const resolver = createAgentResolver(
      makeAgentsGw(candidates, { "package.json": true, "bun.lockb": true }),
      makeClaudeGw({ exitCode: 0, text: '{"agent": "typescript-bun-cli-craftsperson"}' }),
    );

    expect(await resolver(INPUT)).toBe("typescript-bun-cli-craftsperson");
  });

  test("returns null when no candidates are installed", async () => {
    const resolver = createAgentResolver(
      makeAgentsGw([]),
      makeClaudeGw({ exitCode: 0, text: '{"agent": null}' }),
    );
    expect(await resolver(INPUT)).toBeNull();
  });

  test("returns null when Haiku exits non-zero", async () => {
    const resolver = createAgentResolver(
      makeAgentsGw([{ name: "rust-craftsperson", description: "r", source: "global" }]),
      makeClaudeGw({ exitCode: 1, text: "" }),
    );
    expect(await resolver(INPUT)).toBeNull();
  });

  test("returns null when Haiku response is not in the candidate set", async () => {
    const resolver = createAgentResolver(
      makeAgentsGw([{ name: "rust-craftsperson", description: "r", source: "global" }]),
      makeClaudeGw({ exitCode: 0, text: '{"agent": "invented-craftsperson"}' }),
    );
    expect(await resolver(INPUT)).toBeNull();
  });

  test("returns null when Haiku picks null", async () => {
    const resolver = createAgentResolver(
      makeAgentsGw([{ name: "rust-craftsperson", description: "r", source: "global" }]),
      makeClaudeGw({ exitCode: 0, text: '{"agent": null}' }),
    );
    expect(await resolver(INPUT)).toBeNull();
  });

  test("swallows errors from the gateway and returns null", async () => {
    const broken: AgentsGateway = {
      discoverAgents: mock(async () => {
        throw new Error("disk gremlins");
      }),
      probeProjectMarkers: mock(async () => ({})),
    };
    const resolver = createAgentResolver(
      broken,
      makeClaudeGw({ exitCode: 0, text: '{"agent": "rust-craftsperson"}' }),
    );
    expect(await resolver(INPUT)).toBeNull();
  });
});
