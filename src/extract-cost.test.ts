import { describe, expect, test } from "bun:test";
import { aggregatePhaseCosts, extractPhaseCost, sumCosts } from "./extract-cost.ts";

describe("extractPhaseCost (claude)", () => {
  test("pulls cost + token usage from a `result` event", () => {
    const jsonl = [
      JSON.stringify({ type: "system", subtype: "init" }),
      JSON.stringify({ type: "assistant", message: { content: [] } }),
      JSON.stringify({
        type: "result",
        result: "done",
        total_cost_usd: 0.532124,
        usage: {
          input_tokens: 7,
          output_tokens: 6874,
          cache_creation_input_tokens: 50330,
          cache_read_input_tokens: 91353,
        },
        modelUsage: {
          "claude-opus-4-7": { costUSD: 0.532124 },
        },
      }),
    ].join("\n");

    expect(extractPhaseCost(jsonl)).toEqual({
      model: "claude-opus-4-7",
      costUsd: 0.532124,
      tokensIn: 7,
      tokensOut: 6874,
      reasoningTokens: 0,
      cacheRead: 91353,
      cacheWrite: 50330,
    });
  });

  test("returns last `result` for multi-segment transcripts", () => {
    const jsonl = [
      JSON.stringify({
        type: "result",
        total_cost_usd: 0.1,
        usage: { input_tokens: 100, output_tokens: 200 },
      }),
      JSON.stringify({
        type: "result",
        total_cost_usd: 0.05,
        usage: { input_tokens: 50, output_tokens: 80 },
      }),
    ].join("\n");

    const cost = extractPhaseCost(jsonl);
    expect(cost?.costUsd).toBe(0.05);
    expect(cost?.tokensIn).toBe(50);
    expect(cost?.tokensOut).toBe(80);
  });

  test("subscription run with cost=0 is reported honestly, not skipped", () => {
    const jsonl = JSON.stringify({
      type: "result",
      total_cost_usd: 0,
      usage: { input_tokens: 12, output_tokens: 34 },
    });
    expect(extractPhaseCost(jsonl)).toEqual({
      costUsd: 0,
      tokensIn: 12,
      tokensOut: 34,
      reasoningTokens: 0,
      cacheRead: 0,
      cacheWrite: 0,
    });
  });
});

describe("extractPhaseCost (opencode)", () => {
  test("pulls cost + tokens from synthetic `opencode-export` event", () => {
    const jsonl = [
      JSON.stringify({ type: "step_start", sessionID: "sess-1" }),
      JSON.stringify({ type: "text", part: { text: "..." } }),
      JSON.stringify({
        type: "opencode-export",
        sessionID: "sess-1",
        info: {
          id: "sess-1",
          agent: "build",
          model: { id: "gpt-5.5", providerID: "openai" },
          cost: 0.0123,
          tokens: {
            input: 500,
            output: 1200,
            reasoning: 300,
            cache: { read: 2000, write: 800 },
          },
        },
      }),
    ].join("\n");

    expect(extractPhaseCost(jsonl)).toEqual({
      model: "openai/gpt-5.5",
      costUsd: 0.0123,
      tokensIn: 500,
      tokensOut: 1200,
      reasoningTokens: 300,
      cacheRead: 2000,
      cacheWrite: 800,
    });
  });

  test("OAuth-billed opencode run reports cost=0 verbatim", () => {
    const jsonl = JSON.stringify({
      type: "opencode-export",
      info: {
        model: { id: "gpt-5.5", providerID: "openai" },
        cost: 0,
        tokens: { input: 10, output: 20, cache: { read: 0, write: 0 } },
      },
    });
    const cost = extractPhaseCost(jsonl);
    expect(cost?.costUsd).toBe(0);
    expect(cost?.model).toBe("openai/gpt-5.5");
    expect(cost?.tokensIn).toBe(10);
  });

  test("missing info / partial fields default to zero", () => {
    const jsonl = JSON.stringify({ type: "opencode-export", info: {} });
    expect(extractPhaseCost(jsonl)).toEqual({
      costUsd: 0,
      tokensIn: 0,
      tokensOut: 0,
      reasoningTokens: 0,
      cacheRead: 0,
      cacheWrite: 0,
    });
  });
});

describe("extractPhaseCost (opencode step_finish fallback)", () => {
  // Mirrors the real-world failure mode observed in the May 2026 profile
  // bake-off: `opencode export` post-session sometimes returns nothing,
  // so the gateway never appends the synthetic opencode-export event.
  // The per-step step_finish records are still present and carry full
  // cost+token data — sum them as a fallback rather than reporting null.

  test("sums cost + tokens across step_finish records when terminal event is absent", () => {
    const jsonl = [
      JSON.stringify({ type: "step_start", sessionID: "sess-1" }),
      JSON.stringify({
        type: "step_finish",
        sessionID: "sess-1",
        part: {
          type: "step-finish",
          cost: 0.01,
          tokens: { input: 100, output: 20, reasoning: 5, cache: { read: 500, write: 0 } },
        },
      }),
      JSON.stringify({ type: "text", part: { text: "..." } }),
      JSON.stringify({
        type: "step_finish",
        sessionID: "sess-1",
        part: {
          type: "step-finish",
          cost: 0.02,
          tokens: { input: 200, output: 40, reasoning: 10, cache: { read: 1500, write: 0 } },
        },
      }),
      JSON.stringify({
        type: "step_finish",
        sessionID: "sess-1",
        part: {
          type: "step-finish",
          cost: 0.005,
          tokens: { input: 50, output: 10, reasoning: 2, cache: { read: 800, write: 0 } },
        },
      }),
    ].join("\n");

    const cost = extractPhaseCost(jsonl);
    expect(cost).not.toBeNull();
    expect(cost?.costUsd).toBeCloseTo(0.035, 6);
    expect(cost?.tokensIn).toBe(350);
    expect(cost?.tokensOut).toBe(70);
    expect(cost?.reasoningTokens).toBe(17);
    expect(cost?.cacheRead).toBe(2800);
    expect(cost?.cacheWrite).toBe(0);
    expect(cost?.model).toBeUndefined();
  });

  test("prefers terminal opencode-export over step_finish fallback when both present", () => {
    // In a healthy run, both are emitted. opencode-export is the canonical
    // post-run aggregate and includes the model identifier, so it wins.
    const jsonl = [
      JSON.stringify({
        type: "step_finish",
        part: {
          type: "step-finish",
          cost: 0.5,
          tokens: { input: 1, output: 1, cache: { read: 0, write: 0 } },
        },
      }),
      JSON.stringify({
        type: "opencode-export",
        info: {
          model: { id: "gpt-5.5", providerID: "openai" },
          cost: 0.0123,
          tokens: { input: 500, output: 1200, cache: { read: 2000, write: 800 } },
        },
      }),
    ].join("\n");

    const cost = extractPhaseCost(jsonl);
    expect(cost?.costUsd).toBe(0.0123);
    expect(cost?.model).toBe("openai/gpt-5.5");
    expect(cost?.tokensIn).toBe(500);
  });

  test("still returns null when neither terminal event nor step_finish records exist", () => {
    const jsonl = [
      JSON.stringify({ type: "step_start", sessionID: "sess-1" }),
      JSON.stringify({ type: "text", part: { text: "..." } }),
      JSON.stringify({ type: "tool_use", part: { type: "tool", tool: "bash" } }),
    ].join("\n");
    expect(extractPhaseCost(jsonl)).toBeNull();
  });

  test("malformed step_finish records (no part / no tokens) coerce to zero, not throw", () => {
    const jsonl = [
      JSON.stringify({ type: "step_finish" }),
      JSON.stringify({ type: "step_finish", part: {} }),
      JSON.stringify({
        type: "step_finish",
        part: { type: "step-finish", cost: 0.01, tokens: { input: 10, output: 5 } },
      }),
    ].join("\n");

    expect(extractPhaseCost(jsonl)).toEqual({
      costUsd: 0.01,
      tokensIn: 10,
      tokensOut: 5,
      reasoningTokens: 0,
      cacheRead: 0,
      cacheWrite: 0,
    });
  });
});

describe("extractPhaseCost (edge cases)", () => {
  test("returns null for empty input", () => {
    expect(extractPhaseCost("")).toBeNull();
  });

  test("returns null when no cost-bearing event is present", () => {
    const jsonl = [
      JSON.stringify({ type: "system", subtype: "init" }),
      JSON.stringify({ type: "assistant", message: { content: [] } }),
    ].join("\n");
    expect(extractPhaseCost(jsonl)).toBeNull();
  });

  test("tolerates malformed JSONL lines", () => {
    const jsonl = [
      "garbage {",
      JSON.stringify({
        type: "result",
        total_cost_usd: 0.5,
        usage: { input_tokens: 1, output_tokens: 2 },
      }),
      "more garbage",
    ].join("\n");
    const cost = extractPhaseCost(jsonl);
    expect(cost?.costUsd).toBe(0.5);
  });
});

describe("sumCosts", () => {
  test("returns zero totals for empty input", () => {
    expect(sumCosts([])).toEqual({
      costUsd: 0,
      tokensIn: 0,
      tokensOut: 0,
      reasoningTokens: 0,
      cacheRead: 0,
      cacheWrite: 0,
    });
  });

  test("sums across phases without carrying a per-phase model label", () => {
    const total = sumCosts([
      {
        model: "claude-opus-4-7",
        costUsd: 0.5,
        tokensIn: 100,
        tokensOut: 200,
        reasoningTokens: 0,
        cacheRead: 1000,
        cacheWrite: 500,
      },
      {
        model: "claude-sonnet-4-6",
        costUsd: 0.25,
        tokensIn: 50,
        tokensOut: 80,
        reasoningTokens: 0,
        cacheRead: 800,
        cacheWrite: 200,
      },
    ]);
    expect(total.costUsd).toBeCloseTo(0.75, 6);
    expect(total.tokensIn).toBe(150);
    expect(total.tokensOut).toBe(280);
    expect(total.cacheRead).toBe(1800);
    expect(total.cacheWrite).toBe(700);
    expect("model" in total).toBe(false);
  });
});

describe("aggregatePhaseCosts", () => {
  test("returns hasAnyData=false when no phase carries cost", () => {
    const result = aggregatePhaseCosts([
      { phase: "plan", lines: ["not json"] },
      { phase: "execute", lines: [JSON.stringify({ type: "assistant" })] },
    ]);
    expect(result.hasAnyData).toBe(false);
    expect(result.phases).toEqual([]);
    expect(result.total.costUsd).toBe(0);
  });

  test("aggregates across plan/execute/validate preserving order", () => {
    const planLines = [
      JSON.stringify({
        type: "result",
        total_cost_usd: 0.5,
        usage: { input_tokens: 100, output_tokens: 200 },
        modelUsage: { "claude-opus-4-7": {} },
      }),
    ];
    const executeLines = [
      JSON.stringify({
        type: "result",
        total_cost_usd: 1.25,
        usage: { input_tokens: 500, output_tokens: 800 },
        modelUsage: { "claude-sonnet-4-6": {} },
      }),
    ];
    const validateLines = [
      JSON.stringify({
        type: "result",
        total_cost_usd: 0.3,
        usage: { input_tokens: 200, output_tokens: 300 },
        modelUsage: { "claude-opus-4-7": {} },
      }),
    ];

    const result = aggregatePhaseCosts([
      { phase: "plan", lines: planLines },
      { phase: "execute", lines: executeLines },
      { phase: "validate", lines: validateLines },
    ]);

    expect(result.hasAnyData).toBe(true);
    expect(result.phases.map((p) => p.phase)).toEqual(["plan", "execute", "validate"]);
    expect(result.phases[0]?.model).toBe("claude-opus-4-7");
    expect(result.phases[1]?.model).toBe("claude-sonnet-4-6");
    expect(result.total.costUsd).toBeCloseTo(2.05, 6);
    expect(result.total.tokensIn).toBe(800);
    expect(result.total.tokensOut).toBe(1300);
  });

  test("mixes claude + opencode phases in one breakdown", () => {
    const result = aggregatePhaseCosts([
      {
        phase: "plan",
        lines: [
          JSON.stringify({
            type: "result",
            total_cost_usd: 0.1,
            usage: { input_tokens: 10, output_tokens: 20 },
          }),
        ],
      },
      {
        phase: "execute",
        lines: [
          JSON.stringify({
            type: "opencode-export",
            info: {
              model: { id: "gpt-5.5", providerID: "openai" },
              cost: 0.05,
              tokens: { input: 50, output: 100, cache: { read: 0, write: 0 } },
            },
          }),
        ],
      },
    ]);

    expect(result.phases).toHaveLength(2);
    expect(result.phases[1]?.model).toBe("openai/gpt-5.5");
    expect(result.total.costUsd).toBeCloseTo(0.15, 6);
  });

  test("skips phases whose audit has no cost-bearing event", () => {
    const result = aggregatePhaseCosts([
      { phase: "plan", lines: [JSON.stringify({ type: "result", total_cost_usd: 0.1 })] },
      { phase: "execute", lines: [JSON.stringify({ type: "system", subtype: "init" })] },
      { phase: "validate", lines: [JSON.stringify({ type: "result", total_cost_usd: 0.2 })] },
    ]);
    expect(result.phases.map((p) => p.phase)).toEqual(["plan", "validate"]);
    expect(result.total.costUsd).toBeCloseTo(0.3, 6);
  });
});
