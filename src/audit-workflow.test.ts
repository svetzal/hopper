import { describe, expect, test } from "bun:test";
import {
  decodeEvents,
  formatAuditSummary,
  formatDecodedEvents,
  type PhaseInput,
  parsePhaseFromFilename,
  summarizeEvents,
} from "./audit-workflow.ts";
import type { Item } from "./store.ts";

const ITEM_ID = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
const NOW_MS = 1_700_000_000_000; // Fixed reference time for tests

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeItem(overrides?: Partial<Item>): Item {
  return {
    id: ITEM_ID,
    title: "Test task",
    description: "Do the thing",
    status: "in_progress",
    createdAt: new Date(NOW_MS - 60_000).toISOString(),
    ...overrides,
  };
}

function toolUseEvent(id: string, name: string, input: unknown): string {
  return JSON.stringify({
    type: "assistant",
    message: {
      role: "assistant",
      content: [{ type: "tool_use", id, name, input }],
    },
  });
}

function toolResultEvent(toolUseId: string): string {
  return JSON.stringify({
    type: "user",
    message: {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: toolUseId, content: "ok" }],
    },
  });
}

function bashEvent(id: string, command: string): string {
  return toolUseEvent(id, "Bash", { command });
}

function textEvent(role: "assistant" | "user", text: string): string {
  return JSON.stringify({
    type: role,
    message: { role, content: [{ type: "text", text }] },
  });
}

function systemEvent(subtype: string): string {
  return JSON.stringify({ type: "system", subtype });
}

function makePhaseInput(phase: string, lines: string[], mtimeMs = NOW_MS - 5_000): PhaseInput {
  return { phase, lines, mtimeMs };
}

// ── parsePhaseFromFilename ────────────────────────────────────────────────────

describe("parsePhaseFromFilename", () => {
  test("parses audit phase", () => {
    expect(parsePhaseFromFilename(ITEM_ID, `${ITEM_ID}-audit.jsonl`)).toBe("audit");
  });

  test("parses plan phase", () => {
    expect(parsePhaseFromFilename(ITEM_ID, `${ITEM_ID}-plan.jsonl`)).toBe("plan");
  });

  test("parses execute phase", () => {
    expect(parsePhaseFromFilename(ITEM_ID, `${ITEM_ID}-execute.jsonl`)).toBe("execute");
  });

  test("parses execute-2 retry phase", () => {
    expect(parsePhaseFromFilename(ITEM_ID, `${ITEM_ID}-execute-2.jsonl`)).toBe("execute-2");
  });

  test("parses validate-3 retry phase", () => {
    expect(parsePhaseFromFilename(ITEM_ID, `${ITEM_ID}-validate-3.jsonl`)).toBe("validate-3");
  });

  test("returns null for unrelated filename", () => {
    expect(parsePhaseFromFilename(ITEM_ID, "other-id-audit.jsonl")).toBeNull();
  });

  test("returns null for markdown file", () => {
    expect(parsePhaseFromFilename(ITEM_ID, `${ITEM_ID}-plan.md`)).toBeNull();
  });

  test("returns null when no phase segment", () => {
    expect(parsePhaseFromFilename(ITEM_ID, `${ITEM_ID}.jsonl`)).toBeNull();
  });

  test("returns null for empty basename", () => {
    expect(parsePhaseFromFilename(ITEM_ID, "")).toBeNull();
  });
});

// ── summarizeEvents ───────────────────────────────────────────────────────────

describe("summarizeEvents", () => {
  test("returns zero counts for empty input", () => {
    const summary = summarizeEvents([], NOW_MS);

    expect(summary.totalEvents).toBe(0);
    expect(summary.perPhaseEvents).toEqual({});
    expect(summary.lastEventAt).toBeNull();
    expect(summary.lastEventGapSeconds).toBeNull();
    expect(summary.toolHistogram).toEqual([]);
    expect(summary.lastCommands).toEqual([]);
    expect(summary.lastIncompleteToolUse).toBeNull();
  });

  test("counts events per phase", () => {
    const input = makePhaseInput("audit", [
      systemEvent("init"),
      textEvent("assistant", "Starting work"),
      bashEvent("tool-1", "ls -la"),
      toolResultEvent("tool-1"),
    ]);

    const summary = summarizeEvents([input], NOW_MS);

    expect(summary.totalEvents).toBe(4);
    expect(summary.perPhaseEvents.audit).toBe(4);
  });

  test("builds tool histogram", () => {
    const lines = [
      bashEvent("t1", "ls"),
      toolResultEvent("t1"),
      bashEvent("t2", "cat file.ts"),
      toolResultEvent("t2"),
      toolUseEvent("t3", "Read", { file_path: "foo.ts" }),
      toolResultEvent("t3"),
      bashEvent("t4", "echo done"),
      toolResultEvent("t4"),
    ];
    const input = makePhaseInput("execute", lines);

    const summary = summarizeEvents([input], NOW_MS);

    expect(summary.toolHistogram[0]).toEqual({ name: "Bash", count: 3 });
    expect(summary.toolHistogram[1]).toEqual({ name: "Read", count: 1 });
  });

  test("returns top-5 tools only", () => {
    const lines: string[] = [];
    for (let i = 0; i < 10; i++) {
      lines.push(toolUseEvent(`t${i}`, `Tool${i}`, {}));
      lines.push(toolResultEvent(`t${i}`));
    }
    // Add extra Bash calls to make it rank higher
    for (let i = 10; i < 16; i++) {
      lines.push(bashEvent(`t${i}`, `cmd ${i}`));
      lines.push(toolResultEvent(`t${i}`));
    }

    const summary = summarizeEvents([makePhaseInput("execute", lines)], NOW_MS);

    expect(summary.toolHistogram.length).toBeLessThanOrEqual(5);
    expect(summary.toolHistogram[0]?.name).toBe("Bash");
  });

  test("extracts last 3 bash commands", () => {
    const lines = [
      bashEvent("t1", "git status"),
      toolResultEvent("t1"),
      bashEvent("t2", "bun test"),
      toolResultEvent("t2"),
      bashEvent("t3", "bun run lint"),
      toolResultEvent("t3"),
      bashEvent("t4", "bun run build"),
      toolResultEvent("t4"),
    ];
    const input = makePhaseInput("execute", lines);

    const summary = summarizeEvents([input], NOW_MS);

    expect(summary.lastCommands).toHaveLength(3);
    expect(summary.lastCommands[0]).toBe("bun test");
    expect(summary.lastCommands[1]).toBe("bun run lint");
    expect(summary.lastCommands[2]).toBe("bun run build");
  });

  test("identifies last incomplete tool_use (no matching tool_result)", () => {
    const lines = [
      bashEvent("t1", "git status"),
      toolResultEvent("t1"),
      bashEvent("t2", "bun test"), // ← no tool_result follows
    ];
    const input = makePhaseInput("execute", lines);

    const summary = summarizeEvents([input], NOW_MS);

    expect(summary.lastIncompleteToolUse).not.toBeNull();
    expect(summary.lastIncompleteToolUse?.name).toBe("Bash");
    expect(summary.lastIncompleteToolUse?.phase).toBe("execute");
  });

  test("no incomplete tool_use when all are matched", () => {
    const lines = [
      bashEvent("t1", "git status"),
      toolResultEvent("t1"),
      bashEvent("t2", "bun test"),
      toolResultEvent("t2"),
    ];

    const summary = summarizeEvents([makePhaseInput("execute", lines)], NOW_MS);

    expect(summary.lastIncompleteToolUse).toBeNull();
  });

  test("aggregates across multiple phase inputs", () => {
    const planInput = makePhaseInput(
      "plan",
      [systemEvent("init"), textEvent("assistant", "Planning")],
      NOW_MS - 10_000,
    );

    const executeInput = makePhaseInput(
      "execute",
      [bashEvent("t1", "bun test"), toolResultEvent("t1")],
      NOW_MS - 3_000,
    );

    const executeRetryInput = makePhaseInput(
      "execute-2",
      [bashEvent("t2", "bun run lint"), toolResultEvent("t2")],
      NOW_MS - 1_000,
    );

    const summary = summarizeEvents([planInput, executeInput, executeRetryInput], NOW_MS);

    expect(summary.totalEvents).toBe(6);
    expect(summary.perPhaseEvents.plan).toBe(2);
    expect(summary.perPhaseEvents.execute).toBe(2);
    expect(summary.perPhaseEvents["execute-2"]).toBe(2);
    // lastEventAt should be from the latest mtime (execute-2)
    expect(summary.lastEventGapSeconds).toBe(1);
  });

  test("uses max mtime across phase files for lastEventAt", () => {
    const early = makePhaseInput("plan", [systemEvent("init")], NOW_MS - 10_000);
    const late = makePhaseInput("execute", [systemEvent("init")], NOW_MS - 2_000);

    const summary = summarizeEvents([early, late], NOW_MS);

    expect(summary.lastEventGapSeconds).toBe(2);
  });

  test("handles message.content as a string (non-standard format)", () => {
    const line = JSON.stringify({
      type: "assistant",
      message: { role: "assistant", content: "Just a plain string" },
    });

    // Should not throw — just counts as an event
    const summary = summarizeEvents([makePhaseInput("audit", [line])], NOW_MS);

    expect(summary.totalEvents).toBe(1);
  });

  test("skips non-JSON lines gracefully without throwing", () => {
    const lines = ["not json at all", '{"type":"system","subtype":"init"}', "another bad line"];

    // Should not throw — only the valid JSON line counts
    expect(() => summarizeEvents([makePhaseInput("audit", lines)], NOW_MS)).not.toThrow();
    const summary = summarizeEvents([makePhaseInput("audit", lines)], NOW_MS);
    expect(summary.totalEvents).toBe(1);
  });
});

// ── decodeEvents ──────────────────────────────────────────────────────────────

describe("decodeEvents", () => {
  test("returns empty array for empty input", () => {
    expect(decodeEvents([], 10)).toEqual([]);
  });

  test("returns last N events", () => {
    const lines = [
      systemEvent("init"),
      textEvent("assistant", "A"),
      textEvent("assistant", "B"),
      textEvent("assistant", "C"),
      textEvent("assistant", "D"),
    ];
    const events = decodeEvents([makePhaseInput("audit", lines)], 3);

    expect(events).toHaveLength(3);
    expect(events[0]?.textPreview).toBe("B");
    expect(events[1]?.textPreview).toBe("C");
    expect(events[2]?.textPreview).toBe("D");
  });

  test("tags each event with its phase", () => {
    const plan = makePhaseInput("plan", [systemEvent("init")]);
    const execute = makePhaseInput("execute", [textEvent("assistant", "doing it")]);

    const events = decodeEvents([plan, execute], 5);

    expect(events[0]?.phase).toBe("plan");
    expect(events[1]?.phase).toBe("execute");
  });

  test("decodes tool_use with name and input", () => {
    const lines = [toolUseEvent("t1", "Read", { file_path: "src/foo.ts" })];
    const events = decodeEvents([makePhaseInput("execute", lines)], 5);

    expect(events[0]?.kind).toBe("tool_use");
    expect(events[0]?.name).toBe("Read");
    expect(events[0]?.input).toEqual({ file_path: "src/foo.ts" });
  });

  test("decodes system event with subtype as name", () => {
    const events = decodeEvents([makePhaseInput("audit", [systemEvent("task_started")])], 5);

    expect(events[0]?.kind).toBe("system");
    expect(events[0]?.name).toBe("task_started");
  });

  test("decodes result event", () => {
    const line = JSON.stringify({ type: "result", result: "All done" });
    const events = decodeEvents([makePhaseInput("audit", [line])], 5);

    expect(events[0]?.kind).toBe("result");
  });

  test("decodes stderr event with textPreview", () => {
    const line = JSON.stringify({ type: "stderr", text: "Error occurred" });
    const events = decodeEvents([makePhaseInput("audit", [line])], 5);

    expect(events[0]?.kind).toBe("stderr");
    expect(events[0]?.textPreview).toBe("Error occurred");
  });

  test("decodes thinking block with textPreview", () => {
    const line = JSON.stringify({
      type: "assistant",
      message: {
        role: "assistant",
        content: [{ type: "thinking", thinking: "Let me think about this..." }],
      },
    });
    const events = decodeEvents([makePhaseInput("audit", [line])], 5);

    expect(events[0]?.kind).toBe("thinking");
    expect(events[0]?.textPreview).toBe("Let me think about this...");
  });

  test("aggregates events from multiple phases in order", () => {
    const plan = makePhaseInput("plan", [systemEvent("init"), textEvent("assistant", "plan")]);
    const execute = makePhaseInput("execute", [textEvent("assistant", "execute")]);
    const execute2 = makePhaseInput("execute-2", [textEvent("assistant", "retry")]);

    const events = decodeEvents([plan, execute, execute2], 10);

    expect(events).toHaveLength(4);
    expect(events[0]?.phase).toBe("plan");
    expect(events[1]?.phase).toBe("plan");
    expect(events[2]?.phase).toBe("execute");
    expect(events[3]?.phase).toBe("execute-2");
  });

  test("handles content as string without throwing", () => {
    const line = JSON.stringify({
      type: "assistant",
      message: { role: "assistant", content: "plain text string" },
    });

    const events = decodeEvents([makePhaseInput("audit", [line])], 5);

    expect(events[0]?.kind).toBe("text");
    expect(events[0]?.textPreview).toBe("plain text string");
  });
});

// ── summarizeEvents — non-JSON line counting behaviour ────────────────────────

describe("summarizeEvents non-JSON line counting", () => {
  test("non-JSON lines are not counted as events", () => {
    // parseLine returns null for non-JSON, so the event loop skips them
    const lines = ["not json", '{"type":"system","subtype":"init"}'];
    const summary = summarizeEvents([makePhaseInput("audit", lines)], NOW_MS);

    // Only the valid JSON line counts
    expect(summary.totalEvents).toBe(1);
  });
});

// ── formatAuditSummary ────────────────────────────────────────────────────────

describe("formatAuditSummary", () => {
  test("includes item id prefix, title, and status", () => {
    const item = makeItem();
    const summary = summarizeEvents([], NOW_MS);
    const output = formatAuditSummary(item, summary);

    expect(output).toContain("aaaaaaaa");
    expect(output).toContain("Test task");
    expect(output).toContain("in_progress");
  });

  test("shows '(no audit files found)' when no events", () => {
    const output = formatAuditSummary(makeItem(), summarizeEvents([], NOW_MS));
    expect(output).toContain("no audit files found");
  });

  test("shows last event and gap", () => {
    const mtime = NOW_MS - 120_000; // 120 seconds ago
    const input = makePhaseInput("audit", [systemEvent("init")], mtime);
    const summary = summarizeEvents([input], NOW_MS);
    const output = formatAuditSummary(makeItem(), summary);

    expect(output).toContain("Last event:");
    expect(output).toContain("2m"); // ~120s → 2m
  });

  test("shows top tools when present", () => {
    const lines = [
      bashEvent("t1", "ls"),
      toolResultEvent("t1"),
      bashEvent("t2", "pwd"),
      toolResultEvent("t2"),
    ];
    const summary = summarizeEvents([makePhaseInput("execute", lines)], NOW_MS);
    const output = formatAuditSummary(makeItem(), summary);

    expect(output).toContain("Bash: 2");
  });

  test("shows last commands", () => {
    const lines = [bashEvent("t1", "bun test"), toolResultEvent("t1")];
    const summary = summarizeEvents([makePhaseInput("execute", lines)], NOW_MS);
    const output = formatAuditSummary(makeItem(), summary);

    expect(output).toContain("bun test");
  });

  test("shows incomplete tool_use when present", () => {
    const lines = [bashEvent("t1", "bun test")]; // no tool_result
    const summary = summarizeEvents([makePhaseInput("execute", lines)], NOW_MS);
    const output = formatAuditSummary(makeItem(), summary);

    expect(output).toContain("Last incomplete tool_use");
    expect(output).toContain("Bash");
  });
});

// ── formatDecodedEvents ───────────────────────────────────────────────────────

describe("formatDecodedEvents", () => {
  test("returns '(no events)' for empty array", () => {
    expect(formatDecodedEvents([])).toBe("(no events)");
  });

  test("formats each event on its own line", () => {
    const events = decodeEvents(
      [makePhaseInput("audit", [systemEvent("init"), textEvent("assistant", "hello")])],
      10,
    );
    const output = formatDecodedEvents(events);

    expect(output.split("\n")).toHaveLength(2);
  });

  test("includes phase tag in output", () => {
    const events = decodeEvents([makePhaseInput("execute", [systemEvent("init")])], 5);
    expect(formatDecodedEvents(events)).toContain("[execute]");
  });

  test("includes Bash command in output", () => {
    const events = decodeEvents([makePhaseInput("execute", [bashEvent("t1", "bun test")])], 5);
    const output = formatDecodedEvents(events);
    expect(output).toContain("bun test");
  });
});
