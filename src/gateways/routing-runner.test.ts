import { describe, expect, test } from "bun:test";
import type { Profile } from "../profile.ts";
import type { AgentRunner } from "./agent-runner.ts";
import { createRoutingRunner } from "./routing-runner.ts";

function makeStubRunner(label: string): AgentRunner & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    async runSession(prompt, _cwd, _audit, _options) {
      calls.push(`runSession:${label}:${prompt}`);
      return { exitCode: 0, result: label };
    },
    async generateText(prompt, _model, _options) {
      calls.push(`generateText:${label}:${prompt}`);
      return { exitCode: 0, text: label };
    },
  };
}

const CLAUDE_PROFILE: Profile = {
  name: "anthropic",
  runner: "claude",
  models: {
    deep: { model: "opus" },
    balanced: { model: "sonnet" },
    fast: { model: "haiku" },
  },
};

const OPENCODE_PROFILE: Profile = {
  name: "openai",
  runner: "opencode",
  models: {
    deep: { model: "openai/gpt-5.5" },
    balanced: { model: "openai/gpt-5.4" },
    fast: { model: "openai/gpt-5.4-mini" },
  },
};

describe("createRoutingRunner", () => {
  test("runSession routes to claude when profile.runner === 'claude'", async () => {
    const claude = makeStubRunner("CL");
    const opencode = makeStubRunner("OC");
    const runner = createRoutingRunner({ claude, opencode });

    const r = await runner.runSession("hi", "/tmp", "audit.jsonl", { profile: CLAUDE_PROFILE });
    expect(r.result).toBe("CL");
    expect(claude.calls).toEqual(["runSession:CL:hi"]);
    expect(opencode.calls).toEqual([]);
  });

  test("runSession routes to opencode when profile.runner === 'opencode'", async () => {
    const claude = makeStubRunner("CL");
    const opencode = makeStubRunner("OC");
    const runner = createRoutingRunner({ claude, opencode });

    await runner.runSession("hi", "/tmp", "audit.jsonl", { profile: OPENCODE_PROFILE });
    expect(opencode.calls).toEqual(["runSession:OC:hi"]);
    expect(claude.calls).toEqual([]);
  });

  test("generateText routes by profile.runner", async () => {
    const claude = makeStubRunner("CL");
    const opencode = makeStubRunner("OC");
    const runner = createRoutingRunner({ claude, opencode });

    await runner.generateText("p1", "fast", { profile: CLAUDE_PROFILE });
    await runner.generateText("p2", "fast", { profile: OPENCODE_PROFILE });

    expect(claude.calls).toEqual(["generateText:CL:p1"]);
    expect(opencode.calls).toEqual(["generateText:OC:p2"]);
  });

  test("runSession without a profile throws (programmer error)", async () => {
    const runner = createRoutingRunner({
      claude: makeStubRunner("CL"),
      opencode: makeStubRunner("OC"),
    });

    await expect(runner.runSession("hi", "/tmp", "audit.jsonl", {})).rejects.toThrow(
      /without a profile/,
    );
  });

  test("generateText without a profile throws", async () => {
    const runner = createRoutingRunner({
      claude: makeStubRunner("CL"),
      opencode: makeStubRunner("OC"),
    });

    // @ts-expect-error — intentionally violating the type to test runtime guard
    await expect(runner.generateText("hi", "fast", {})).rejects.toThrow(/without a profile/);
  });
});
