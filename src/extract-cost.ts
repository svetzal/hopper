/**
 * Extract per-phase token + cost telemetry from a JSONL audit stream.
 *
 * Both runners emit a single terminal cost-bearing event per phase:
 *   - claude  `--output-format stream-json` ends with `{"type":"result", total_cost_usd, usage:{...}}`
 *   - opencode (synthesized by `opencode-gateway.ts`) appends `{"type":"opencode-export", info:{cost, tokens:{...}, model:{...}}}`
 *
 * Subscription/OAuth runs report cost as 0; that is honest data, not a bug, so
 * we surface zero without special-casing it here. Display copy can decide
 * whether to dim or omit zero-cost phases.
 */

export interface PhaseCost {
  /** Provider-qualified model identifier when known, e.g. "claude-opus-4-7" or "openai/gpt-5.5". */
  model?: string;
  /** Dollar cost reported by the provider. */
  costUsd: number;
  /** Non-cached input tokens. */
  tokensIn: number;
  /** Output tokens (including reasoning, where the provider doesn't split them out). */
  tokensOut: number;
  /** Reasoning-only tokens, when separately reported (opencode); 0 otherwise. */
  reasoningTokens: number;
  /** Tokens served from cache (cheap). */
  cacheRead: number;
  /** Tokens written to cache (premium-priced for the first hit). */
  cacheWrite: number;
}

function zeroCost(): PhaseCost {
  return {
    costUsd: 0,
    tokensIn: 0,
    tokensOut: 0,
    reasoningTokens: 0,
    cacheRead: 0,
    cacheWrite: 0,
  };
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

/**
 * Parse a JSONL audit stream and return the cost telemetry from the *last*
 * cost-bearing event. Returns `null` when no such event is present (e.g. the
 * phase was interrupted before the runner reported usage).
 *
 * Multi-segment claude transcripts (a `task_notification` resume produces two
 * `init`/`result` segment pairs) are handled by taking the last `result` —
 * this mirrors {@link extractResult} so the cost reported aligns with the
 * result text shown.
 */
export function extractPhaseCost(jsonlOutput: string): PhaseCost | null {
  if (!jsonlOutput) return null;
  let last: PhaseCost | null = null;

  for (const line of jsonlOutput.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let obj: unknown;
    try {
      obj = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (!isRecord(obj)) continue;

    if (obj.type === "result") {
      const usage = isRecord(obj.usage) ? obj.usage : {};
      const cost = zeroCost();
      cost.costUsd = numberOr(obj.total_cost_usd, 0);
      cost.tokensIn = numberOr(usage.input_tokens, 0);
      cost.tokensOut = numberOr(usage.output_tokens, 0);
      cost.cacheRead = numberOr(usage.cache_read_input_tokens, 0);
      cost.cacheWrite = numberOr(usage.cache_creation_input_tokens, 0);
      // Pick the model name from modelUsage when available — claude reports
      // an exact model ID there (e.g. "claude-opus-4-7") rather than the alias.
      if (isRecord(obj.modelUsage)) {
        const keys = Object.keys(obj.modelUsage);
        if (keys.length > 0) cost.model = keys[0];
      }
      last = cost;
      continue;
    }

    if (obj.type === "opencode-export") {
      const info = isRecord(obj.info) ? obj.info : {};
      const tokens = isRecord(info.tokens) ? info.tokens : {};
      const cache = isRecord(tokens.cache) ? tokens.cache : {};
      const modelInfo = isRecord(info.model) ? info.model : {};
      const cost = zeroCost();
      cost.costUsd = numberOr(info.cost, 0);
      cost.tokensIn = numberOr(tokens.input, 0);
      cost.tokensOut = numberOr(tokens.output, 0);
      cost.reasoningTokens = numberOr(tokens.reasoning, 0);
      cost.cacheRead = numberOr(cache.read, 0);
      cost.cacheWrite = numberOr(cache.write, 0);
      const provider = typeof modelInfo.providerID === "string" ? modelInfo.providerID : "";
      const id = typeof modelInfo.id === "string" ? modelInfo.id : "";
      if (provider && id) cost.model = `${provider}/${id}`;
      else if (id) cost.model = id;
      last = cost;
    }
  }

  return last;
}

/**
 * Sum a list of phase costs. Models are dropped (the aggregate spans phases
 * that may have used different tiers, so a single model label would lie).
 */
export function sumCosts(costs: PhaseCost[]): PhaseCost {
  const total = zeroCost();
  for (const c of costs) {
    total.costUsd += c.costUsd;
    total.tokensIn += c.tokensIn;
    total.tokensOut += c.tokensOut;
    total.reasoningTokens += c.reasoningTokens;
    total.cacheRead += c.cacheRead;
    total.cacheWrite += c.cacheWrite;
  }
  return total;
}

/** One phase's JSONL content paired with its phase label. Pure I/O input. */
export interface PhaseLines {
  /** Phase label, e.g. "plan" | "execute" | "validate" | "execute-2". */
  phase: string;
  /** Raw JSONL lines from the phase audit file. */
  lines: string[];
}

/** Per-phase cost row, plus the runner-reported model when known. */
export interface PhaseCostRow extends PhaseCost {
  phase: string;
}

/** Aggregate result returned by {@link aggregatePhaseCosts}. */
export interface CostBreakdown {
  /** Per-phase rows, in the order they were supplied. */
  phases: PhaseCostRow[];
  /** Sum across phases. Zero across the board when no phase reported cost. */
  total: PhaseCost;
  /** True when at least one phase reported a cost-bearing event. */
  hasAnyData: boolean;
}

/**
 * Aggregate cost telemetry across a sequence of phases. Phases that yielded
 * no cost-bearing event (interrupted runs, fast-tier helper sessions whose
 * audit was overwritten, etc.) are silently skipped from the per-phase list
 * but reflected in `hasAnyData`.
 *
 * Pure: takes already-loaded JSONL lines, does no I/O.
 */
export function aggregatePhaseCosts(inputs: PhaseLines[]): CostBreakdown {
  const phases: PhaseCostRow[] = [];
  for (const input of inputs) {
    const cost = extractPhaseCost(input.lines.join("\n"));
    if (cost === null) continue;
    phases.push({ phase: input.phase, ...cost });
  }
  return {
    phases,
    total: sumCosts(phases),
    hasAnyData: phases.length > 0,
  };
}
