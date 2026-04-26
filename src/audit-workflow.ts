import type { Item } from "./store.ts";

/** One phase's worth of input lines and metadata. */
export interface PhaseInput {
  /** Phase label, e.g. "audit" | "plan" | "execute" | "execute-2" | "validate-3" */
  phase: string;
  /** Raw JSONL lines from the phase file. */
  lines: string[];
  /** Last-modified time in milliseconds for the backing file. */
  mtimeMs: number;
}

/** A single decoded event from a JSONL stream. */
export type DecodedEvent = {
  /** Which phase this event came from. */
  phase: string;
  kind:
    | "tool_use"
    | "tool_result"
    | "text"
    | "thinking"
    | "system"
    | "result"
    | "stderr"
    | "start"
    | "other";
  /** assistant | user — present when derived from a message turn. */
  role?: "assistant" | "user";
  /** tool_use: tool name; system event: subtype. */
  name?: string;
  /** tool_use input object (kept as-is; callers format on display). */
  input?: unknown;
  /** First ~120 chars of text / thinking content. */
  textPreview?: string;
};

export interface AuditSummary {
  totalEvents: number;
  perPhaseEvents: Record<string, number>;
  /** ISO timestamp of the most recently modified phase file, or null if no files. */
  lastEventAt: string | null;
  /** Seconds elapsed since lastEventAt, or null if no files. */
  lastEventGapSeconds: number | null;
  /** Top-5 tool names by call count, descending. */
  toolHistogram: Array<{ name: string; count: number }>;
  /** Last 3 Bash command strings observed in tool_use blocks. */
  lastCommands: string[];
  /** Last unmatched (no tool_result) tool_use block across all inputs, or null. */
  lastIncompleteToolUse: { phase: string; name: string; input: unknown } | null;
}

// ── Internal helpers ──────────────────────────────────────────────────────────

interface ContentBlock {
  type: string;
  [key: string]: unknown;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

function isContentBlock(v: unknown): v is ContentBlock {
  return typeof v === "object" && v !== null && "type" in v;
}

/**
 * Parse a single JSONL line into a top-level event object.
 * Returns null when the line is not valid JSON or not a plain object.
 */
function parseLine(line: string): Record<string, unknown> | null {
  try {
    const obj = JSON.parse(line);
    return isRecord(obj) ? obj : null;
  } catch {
    return null;
  }
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Parse a phase label from a JSONL filename.
 *
 * Precondition: `itemId` must be the full UUID, not a prefix.
 *
 * @param itemId  The full item UUID.
 * @param basename  e.g. `<id>-execute-2.jsonl`
 * @returns  e.g. `"execute-2"`, `"audit"`, or `null` for non-matching names.
 */
export function parsePhaseFromFilename(itemId: string, basename: string): string | null {
  const prefix = `${itemId}-`;
  const suffix = ".jsonl";
  if (!basename.startsWith(prefix) || !basename.endsWith(suffix)) return null;
  const phase = basename.slice(prefix.length, -suffix.length);
  return phase.length > 0 ? phase : null;
}

/**
 * Summarize events across one or more phase inputs.
 *
 * Uses its own raw parsing loop (not `decodeEvents`) so it can track tool_use
 * IDs for incomplete-detection without exposing them in the public event type.
 *
 * @param inputs  Phase inputs (may be empty).
 * @param nowMs   Current timestamp in ms (injectable for tests).
 */
export function summarizeEvents(inputs: PhaseInput[], nowMs: number): AuditSummary {
  const perPhaseEvents: Record<string, number> = {};
  const toolCounts: Map<string, number> = new Map();
  const bashCommands: string[] = [];

  // tool_use id → { phase, name, input } — cleared when a matching tool_result appears
  const openToolUses: Map<string, { phase: string; name: string; input: unknown }> = new Map();

  let lastMtimeMs = 0;
  let totalEvents = 0;

  for (const input of inputs) {
    if (input.mtimeMs > lastMtimeMs) lastMtimeMs = input.mtimeMs;

    let phaseCount = 0;

    for (const line of input.lines) {
      const obj = parseLine(line);
      if (!obj) continue;

      phaseCount++;

      const topType = obj.type as string | undefined;

      if (topType === "assistant" || topType === "user") {
        const msg = isRecord(obj.message) ? obj.message : {};
        const rawContent = msg.content;

        const blocks: unknown[] = Array.isArray(rawContent)
          ? rawContent
          : typeof rawContent === "string"
            ? [{ type: "text", text: rawContent }]
            : [];

        for (const block of blocks) {
          if (!isContentBlock(block)) continue;

          if (block.type === "tool_use") {
            const name = typeof block.name === "string" ? block.name : "";
            const id = typeof block.id === "string" ? block.id : null;
            const blockInput = block.input;

            // Histogram
            if (name) {
              toolCounts.set(name, (toolCounts.get(name) ?? 0) + 1);
            }

            // Track open tool_use (by id when available)
            if (id && name) {
              openToolUses.set(id, { phase: input.phase, name, input: blockInput });
            }

            // Bash commands
            if (name === "Bash" && isRecord(blockInput)) {
              const cmd = blockInput.command;
              if (typeof cmd === "string") {
                bashCommands.push(cmd.replace(/\n/g, " ").slice(0, 200));
              }
            }
          }

          if (block.type === "tool_result") {
            const toolUseId = typeof block.tool_use_id === "string" ? block.tool_use_id : null;
            if (toolUseId) {
              openToolUses.delete(toolUseId);
            }
          }
        }
      }
    }

    perPhaseEvents[input.phase] = phaseCount;
    totalEvents += phaseCount;
  }

  // Last remaining open tool_use is the last incomplete one
  let lastIncompleteToolUse: { phase: string; name: string; input: unknown } | null = null;
  for (const entry of openToolUses.values()) {
    lastIncompleteToolUse = entry;
  }

  // Top-5 tool histogram
  const toolHistogram = [...toolCounts.entries()]
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 5);

  // Last 3 Bash commands
  const lastCommands = bashCommands.slice(-3);

  const lastEventAt = lastMtimeMs > 0 ? new Date(lastMtimeMs).toISOString() : null;
  const lastEventGapSeconds = lastMtimeMs > 0 ? Math.round((nowMs - lastMtimeMs) / 1000) : null;

  return {
    totalEvents,
    perPhaseEvents,
    lastEventAt,
    lastEventGapSeconds,
    toolHistogram,
    lastCommands,
    lastIncompleteToolUse,
  };
}

/**
 * Decode all events from phase inputs and return the last N.
 */
export function decodeEvents(inputs: PhaseInput[], n: number): DecodedEvent[] {
  const all: DecodedEvent[] = [];

  for (const input of inputs) {
    for (const line of input.lines) {
      const obj = parseLine(line);
      if (!obj) continue;

      const topType = obj.type as string | undefined;

      if (topType === "result") {
        all.push({ phase: input.phase, kind: "result" });
        continue;
      }
      if (topType === "stderr") {
        const text = typeof obj.text === "string" ? obj.text : "";
        all.push({ phase: input.phase, kind: "stderr", textPreview: text.slice(0, 120) });
        continue;
      }
      if (topType === "start") {
        all.push({ phase: input.phase, kind: "start" });
        continue;
      }
      if (topType === "system") {
        const subtype = typeof obj.subtype === "string" ? obj.subtype : undefined;
        all.push({ phase: input.phase, kind: "system", name: subtype });
        continue;
      }

      if (topType === "assistant" || topType === "user") {
        const msg = isRecord(obj.message) ? obj.message : {};
        const role =
          (msg.role as "assistant" | "user" | undefined) ?? (topType as "assistant" | "user");
        const rawContent = msg.content;

        const blocks: unknown[] = Array.isArray(rawContent)
          ? rawContent
          : typeof rawContent === "string"
            ? [{ type: "text", text: rawContent }]
            : [];

        for (const block of blocks) {
          if (!isContentBlock(block)) continue;

          switch (block.type) {
            case "text": {
              const text = typeof block.text === "string" ? block.text : "";
              all.push({ phase: input.phase, kind: "text", role, textPreview: text.slice(0, 120) });
              break;
            }
            case "thinking": {
              const thinking = typeof block.thinking === "string" ? block.thinking : "";
              all.push({
                phase: input.phase,
                kind: "thinking",
                role,
                textPreview: thinking.slice(0, 120),
              });
              break;
            }
            case "tool_use": {
              const name = typeof block.name === "string" ? block.name : undefined;
              all.push({ phase: input.phase, kind: "tool_use", role, name, input: block.input });
              break;
            }
            case "tool_result": {
              all.push({ phase: input.phase, kind: "tool_result", role });
              break;
            }
            default: {
              all.push({ phase: input.phase, kind: "other", role });
            }
          }
        }
        continue;
      }

      all.push({ phase: input.phase, kind: "other" });
    }
  }

  return all.slice(-n);
}

/**
 * Human-readable summary block for `hopper audit <id>`.
 */
export function formatAuditSummary(item: Item, summary: AuditSummary): string {
  const lines: string[] = [];

  lines.push(`Audit: ${item.id.slice(0, 8)}  ${item.title}`);
  lines.push(`Status: ${item.status}`);
  lines.push(`Total events: ${summary.totalEvents}`);

  const phaseEntries = Object.entries(summary.perPhaseEvents);
  if (phaseEntries.length > 1) {
    const breakdown = phaseEntries.map(([p, n]) => `${p}: ${n}`).join("  ");
    lines.push(`Per-phase: ${breakdown}`);
  }

  if (summary.lastEventAt) {
    lines.push(`Last event: ${summary.lastEventAt}`);
  } else {
    lines.push("Last event: (no audit files found)");
  }

  if (summary.lastEventGapSeconds !== null) {
    const gap = summary.lastEventGapSeconds;
    let gapStr: string;
    if (gap < 60) gapStr = `${gap}s`;
    else if (gap < 3600) gapStr = `${Math.round(gap / 60)}m`;
    else gapStr = `${Math.round(gap / 3600)}h`;
    lines.push(`Gap since last event: ${gapStr}`);
  }

  if (summary.toolHistogram.length > 0) {
    lines.push("Top tools:");
    for (const entry of summary.toolHistogram) {
      lines.push(`  ${entry.name}: ${entry.count}`);
    }
  }

  if (summary.lastCommands.length > 0) {
    lines.push("Last commands:");
    for (const cmd of summary.lastCommands) {
      lines.push(`  $ ${cmd.slice(0, 120)}`);
    }
  }

  if (summary.lastIncompleteToolUse) {
    const t = summary.lastIncompleteToolUse;
    lines.push(`Last incomplete tool_use: [${t.phase}] ${t.name}`);
    if (isRecord(t.input) && typeof t.input.command === "string") {
      lines.push(`  command: ${t.input.command.slice(0, 120)}`);
    }
  }

  return lines.join("\n");
}

/**
 * Human-readable event list for `hopper audit <id> --tail <n>`.
 */
export function formatDecodedEvents(events: DecodedEvent[]): string {
  if (events.length === 0) return "(no events)";

  return events
    .map((e) => {
      const parts: string[] = [`[${e.phase}]`, e.kind];

      if (e.role) parts.push(`(${e.role})`);
      if (e.name) parts.push(e.name);

      if (e.kind === "tool_use" && isRecord(e.input)) {
        const cmd = e.input.command;
        const file = e.input.file_path ?? e.input.path;
        if (typeof cmd === "string") parts.push(`$ ${cmd.slice(0, 80)}`);
        else if (typeof file === "string") parts.push(file.slice(0, 80));
      } else if (e.textPreview) {
        parts.push(e.textPreview.slice(0, 80));
      }

      return parts.join(" ");
    })
    .join("\n");
}
