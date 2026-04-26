import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { AuditGateway, PhaseFile } from "../gateways/audit-gateway.ts";
import { addItem } from "../store.ts";
import { auditCommand } from "./audit.ts";
import { makeItem, makeParsed, setupTempStoreDir } from "./test-helpers.ts";

// ── Fake gateway ──────────────────────────────────────────────────────────────

function makePhaseFile(
  itemId: string,
  phase: string,
  lines: string[],
): PhaseFile & { lines: string[] } {
  return {
    path: `/fake/audit/${itemId}-${phase}.jsonl`,
    name: `${itemId}-${phase}.jsonl`,
    mtimeMs: Date.now() - 5_000,
    lines,
  };
}

interface FakeGatewayConfig {
  phaseFiles?: Array<PhaseFile & { lines: string[] }>;
  planContent?: string | null;
  resultContent?: string | null;
  readJsonlCalls?: string[];
}

function makeFakeGateway(
  config: FakeGatewayConfig = {},
): AuditGateway & { readJsonlCalls: string[] } {
  const readJsonlCalls: string[] = [];

  return {
    readJsonlCalls,

    async listPhaseFiles(_itemId: string): Promise<PhaseFile[]> {
      return config.phaseFiles ?? [];
    },

    async readJsonlLines(path: string): Promise<{ lines: string[]; mtimeMs: number } | null> {
      readJsonlCalls.push(path);
      const file = config.phaseFiles?.find((f) => f.path === path);
      if (!file) return null;
      return { lines: file.lines, mtimeMs: file.mtimeMs };
    },

    async readMarkdown(path: string): Promise<string | null> {
      if (path.endsWith("-plan.md")) return config.planContent ?? null;
      if (path.endsWith("-result.md")) return config.resultContent ?? null;
      return null;
    },

    paths(itemId: string) {
      return {
        plan: `/fake/audit/${itemId}-plan.md`,
        result: `/fake/audit/${itemId}-result.md`,
        auditDir: "/fake/audit",
      };
    },
  };
}

// ── JSONL fixture helpers ─────────────────────────────────────────────────────

function systemLine(subtype: string): string {
  return JSON.stringify({ type: "system", subtype });
}

function bashLine(id: string, command: string): string {
  return JSON.stringify({
    type: "assistant",
    message: {
      role: "assistant",
      content: [{ type: "tool_use", id, name: "Bash", input: { command } }],
    },
  });
}

function toolResultLine(toolUseId: string): string {
  return JSON.stringify({
    type: "user",
    message: {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: toolUseId, content: "done" }],
    },
  });
}

// ── Test setup ────────────────────────────────────────────────────────────────

describe("auditCommand", () => {
  const storeDir = setupTempStoreDir("hopper-audit-test-");

  beforeEach(storeDir.beforeEach);
  afterEach(storeDir.afterEach);

  // ── Missing id ──────────────────────────────────────────────────────────────

  test("returns error when no id is provided", async () => {
    const gateway = makeFakeGateway();
    const result = await auditCommand(makeParsed("audit", []), gateway);

    expect(result.status).toBe("error");
    if (result.status === "error") {
      expect(result.message).toContain("Usage: hopper audit <id>");
    }
  });

  // ── Non-existent item ───────────────────────────────────────────────────────

  test("returns error when item id not found", async () => {
    const gateway = makeFakeGateway();
    const result = await auditCommand(makeParsed("audit", ["nonexistent"]), gateway);

    expect(result.status).toBe("error");
    // Gateway should NOT be called — error is raised before I/O
    // (store lookup throws, withStoreError catches it)
    expect(gateway.readJsonlCalls).toHaveLength(0);
  });

  // ── Conflicting flags (must error BEFORE I/O) ───────────────────────────────

  test("returns error for --plan --result combination without calling gateway", async () => {
    const item = makeItem();
    await addItem(item);
    const gateway = makeFakeGateway({ planContent: "# Plan" });

    const result = await auditCommand(
      makeParsed("audit", [item.id], { plan: true, result: true }),
      gateway,
    );

    expect(result.status).toBe("error");
    if (result.status === "error") {
      expect(result.message).toContain("Cannot use --plan and --result");
    }
    expect(gateway.readJsonlCalls).toHaveLength(0);
  });

  test("returns error for --phase --plan combination without calling gateway", async () => {
    const item = makeItem();
    await addItem(item);
    const gateway = makeFakeGateway({ planContent: "# Plan" });

    const result = await auditCommand(
      makeParsed("audit", [item.id], { phase: "execute", plan: true }),
      gateway,
    );

    expect(result.status).toBe("error");
    if (result.status === "error") {
      expect(result.message).toContain("--phase cannot be combined");
    }
    expect(gateway.readJsonlCalls).toHaveLength(0);
  });

  test("returns error for --phase --result combination", async () => {
    const item = makeItem();
    await addItem(item);
    const gateway = makeFakeGateway({ resultContent: "Done" });

    const result = await auditCommand(
      makeParsed("audit", [item.id], { phase: "execute", result: true }),
      gateway,
    );

    expect(result.status).toBe("error");
    if (result.status === "error") {
      expect(result.message).toContain("--phase cannot be combined");
    }
    expect(gateway.readJsonlCalls).toHaveLength(0);
  });

  test("returns error for --tail --plan combination", async () => {
    const item = makeItem();
    await addItem(item);
    const gateway = makeFakeGateway({ planContent: "# Plan" });

    const result = await auditCommand(
      makeParsed("audit", [item.id], { tail: "5", plan: true }),
      gateway,
    );

    expect(result.status).toBe("error");
    if (result.status === "error") {
      expect(result.message).toContain("--tail cannot be combined");
    }
    expect(gateway.readJsonlCalls).toHaveLength(0);
  });

  test("returns error for non-integer --tail", async () => {
    const item = makeItem();
    await addItem(item);
    const gateway = makeFakeGateway();

    const result = await auditCommand(makeParsed("audit", [item.id], { tail: "abc" }), gateway);

    expect(result.status).toBe("error");
    if (result.status === "error") {
      expect(result.message).toContain("--tail requires a positive integer");
    }
  });

  // ── Default summary ─────────────────────────────────────────────────────────

  test("returns summary for a single-phase item", async () => {
    const item = makeItem({ status: "in_progress" });
    await addItem(item);

    const phaseFile = makePhaseFile(item.id, "audit", [
      systemLine("init"),
      bashLine("t1", "bun test"),
      toolResultLine("t1"),
    ]);
    const gateway = makeFakeGateway({ phaseFiles: [phaseFile] });

    const result = await auditCommand(makeParsed("audit", [item.id]), gateway);

    expect(result.status).toBe("success");
    if (result.status === "success") {
      const data = result.data as Record<string, unknown>;
      expect(data.itemId).toBe(item.id);
      expect(data.status).toBe("in_progress");
      expect(typeof data.totalEvents).toBe("number");
      expect(result.humanOutput).toContain("Total events");
    }
  });

  test("summary --json output is JSON-serializable", async () => {
    const item = makeItem();
    await addItem(item);
    const phaseFile = makePhaseFile(item.id, "audit", [systemLine("init")]);
    const gateway = makeFakeGateway({ phaseFiles: [phaseFile] });

    const result = await auditCommand(makeParsed("audit", [item.id]), gateway);

    expect(result.status).toBe("success");
    if (result.status === "success") {
      const serialized = JSON.parse(JSON.stringify(result.data));
      expect(serialized).toBeDefined();
      expect(typeof serialized.totalEvents).toBe("number");
    }
  });

  // ── Engineering item with multiple phases ───────────────────────────────────

  test("aggregates multiple phase files for engineering items", async () => {
    const item = makeItem({ type: "engineering", status: "in_progress" });
    await addItem(item);

    const planFile = makePhaseFile(item.id, "plan", [systemLine("init")]);
    const executeFile = makePhaseFile(item.id, "execute", [
      bashLine("t1", "bun test"),
      toolResultLine("t1"),
    ]);
    const execute2File = makePhaseFile(item.id, "execute-2", [
      bashLine("t2", "bun run lint"),
      toolResultLine("t2"),
    ]);

    const gateway = makeFakeGateway({ phaseFiles: [planFile, executeFile, execute2File] });

    const result = await auditCommand(makeParsed("audit", [item.id]), gateway);

    expect(result.status).toBe("success");
    if (result.status === "success") {
      const data = result.data as Record<string, unknown>;
      expect(data.totalEvents).toBe(5); // 1 + 2 + 2
      const perPhase = data.perPhaseEvents as Record<string, number>;
      expect(perPhase.plan).toBe(1);
      expect(perPhase.execute).toBe(2);
      expect(perPhase["execute-2"]).toBe(2);
    }
  });

  test("--phase execute filters to execute and execute-2 files", async () => {
    const item = makeItem({ type: "engineering", status: "in_progress" });
    await addItem(item);

    const planFile = makePhaseFile(item.id, "plan", [systemLine("plan-init")]);
    const executeFile = makePhaseFile(item.id, "execute", [
      bashLine("t1", "bun test"),
      toolResultLine("t1"),
    ]);
    const execute2File = makePhaseFile(item.id, "execute-2", [
      bashLine("t2", "bun lint"),
      toolResultLine("t2"),
    ]);

    const gateway = makeFakeGateway({ phaseFiles: [planFile, executeFile, execute2File] });

    const result = await auditCommand(
      makeParsed("audit", [item.id], { phase: "execute" }),
      gateway,
    );

    expect(result.status).toBe("success");
    if (result.status === "success") {
      const data = result.data as Record<string, unknown>;
      const perPhase = data.perPhaseEvents as Record<string, number>;
      expect(perPhase.plan).toBeUndefined();
      expect(perPhase.execute).toBe(2);
      expect(perPhase["execute-2"]).toBe(2);
    }
  });

  test("--phase on non-engineering item returns friendly error", async () => {
    const item = makeItem({ type: "task", status: "in_progress" });
    await addItem(item);
    const gateway = makeFakeGateway();

    const result = await auditCommand(
      makeParsed("audit", [item.id], { phase: "execute" }),
      gateway,
    );

    expect(result.status).toBe("error");
    if (result.status === "error") {
      expect(result.message).toContain("--phase is only available for engineering items");
    }
  });

  // ── --plan ──────────────────────────────────────────────────────────────────

  test("--plan returns plan markdown when present", async () => {
    const item = makeItem({ type: "engineering", status: "in_progress" });
    await addItem(item);
    const gateway = makeFakeGateway({ planContent: "# My Plan\n\nDo things." });

    const result = await auditCommand(makeParsed("audit", [item.id], { plan: true }), gateway);

    expect(result.status).toBe("success");
    if (result.status === "success") {
      expect(result.humanOutput).toContain("# My Plan");
      const data = result.data as Record<string, unknown>;
      expect(data.plan).toBe("# My Plan\n\nDo things.");
    }
  });

  test("--plan returns friendly error when plan file is absent", async () => {
    const item = makeItem({ type: "engineering", status: "in_progress" });
    await addItem(item);
    const gateway = makeFakeGateway({ planContent: null });

    const result = await auditCommand(makeParsed("audit", [item.id], { plan: true }), gateway);

    expect(result.status).toBe("error");
    if (result.status === "error") {
      expect(result.message).toContain("No plan found");
    }
  });

  // ── --result ────────────────────────────────────────────────────────────────

  test("--result on in-progress item returns placeholder when result file absent", async () => {
    const item = makeItem({ status: "in_progress" });
    await addItem(item);
    const gateway = makeFakeGateway({ resultContent: null });

    const result = await auditCommand(makeParsed("audit", [item.id], { result: true }), gateway);

    expect(result.status).toBe("success");
    if (result.status === "success") {
      expect(result.humanOutput).toContain("in progress");
      const data = result.data as Record<string, unknown>;
      expect(data.inProgress).toBe(true);
      expect(data.result).toBeNull();
    }
  });

  test("--result on completed item returns file content", async () => {
    const item = makeItem({ status: "completed" });
    await addItem(item);
    const gateway = makeFakeGateway({ resultContent: "Task completed successfully." });

    const result = await auditCommand(makeParsed("audit", [item.id], { result: true }), gateway);

    expect(result.status).toBe("success");
    if (result.status === "success") {
      expect(result.humanOutput).toBe("Task completed successfully.");
    }
  });

  test("--result on completed item returns error when result file absent", async () => {
    const item = makeItem({ status: "completed" });
    await addItem(item);
    const gateway = makeFakeGateway({ resultContent: null });

    const result = await auditCommand(makeParsed("audit", [item.id], { result: true }), gateway);

    expect(result.status).toBe("error");
    if (result.status === "error") {
      expect(result.message).toContain("No result found");
    }
  });

  // ── --tail ──────────────────────────────────────────────────────────────────

  test("--tail 3 returns last 3 decoded events", async () => {
    const item = makeItem({ status: "in_progress" });
    await addItem(item);

    const phaseFile = makePhaseFile(item.id, "audit", [
      systemLine("init"),
      systemLine("task_started"),
      systemLine("a"),
      systemLine("b"),
      systemLine("c"),
    ]);
    const gateway = makeFakeGateway({ phaseFiles: [phaseFile] });

    const result = await auditCommand(makeParsed("audit", [item.id], { tail: "3" }), gateway);

    expect(result.status).toBe("success");
    if (result.status === "success") {
      const events = result.data as unknown[];
      expect(events).toHaveLength(3);
    }
  });

  test("--tail --json returns JSON-serializable events array", async () => {
    const item = makeItem({ status: "in_progress" });
    await addItem(item);

    const phaseFile = makePhaseFile(item.id, "audit", [
      bashLine("t1", "bun test"),
      toolResultLine("t1"),
    ]);
    const gateway = makeFakeGateway({ phaseFiles: [phaseFile] });

    const result = await auditCommand(makeParsed("audit", [item.id], { tail: "5" }), gateway);

    expect(result.status).toBe("success");
    if (result.status === "success") {
      const roundTripped = JSON.parse(JSON.stringify(result.data));
      expect(Array.isArray(roundTripped)).toBe(true);
    }
  });
});
