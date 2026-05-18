import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { AuditGateway, PhaseFile } from "../gateways/audit-gateway.ts";
import { addItem } from "../store.ts";
import { makeItem, makeParsed, setupTempStoreDir } from "../test-helpers.ts";
import { showCommand } from "./show.ts";

function makeFakeGateway(phaseFiles: Array<PhaseFile & { lines: string[] }> = []): AuditGateway {
  return {
    async listPhaseFiles(_itemId: string): Promise<PhaseFile[]> {
      return phaseFiles;
    },
    async readJsonlLines(path: string): Promise<{ lines: string[]; mtimeMs: number } | null> {
      const file = phaseFiles.find((f) => f.path === path);
      if (!file) return null;
      return { lines: file.lines, mtimeMs: file.mtimeMs };
    },
    async readMarkdown(): Promise<string | null> {
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

function phaseFile(
  itemId: string,
  phase: string,
  lines: string[],
  mtimeMs = Date.now() - 5_000,
): PhaseFile & { lines: string[] } {
  return {
    path: `/fake/audit/${itemId}-${phase}.jsonl`,
    name: `${itemId}-${phase}.jsonl`,
    mtimeMs,
    lines,
  };
}

describe("showCommand", () => {
  const storeDir = setupTempStoreDir("hopper-show-test-");

  beforeEach(storeDir.beforeEach);
  afterEach(storeDir.afterEach);

  test("returns error when no id is provided", async () => {
    const result = await showCommand(makeParsed("show", []), makeFakeGateway());

    expect(result.status).toBe("error");
    if (result.status === "error") {
      expect(result.message).toBe("Usage: hopper show <id>");
    }
  });

  test("returns success with item detail in humanOutput", async () => {
    const item = makeItem();
    await addItem(item);

    const result = await showCommand(makeParsed("show", [item.id]), makeFakeGateway());

    expect(result.status).toBe("success");
    if (result.status === "success") {
      expect(result.humanOutput).toContain("Title:");
      expect(result.humanOutput).toContain("Status:");
      expect(result.humanOutput).toContain("Description:");
    }
  });

  test("data contains the full item", async () => {
    const item = makeItem({ title: "Specific task" });
    await addItem(item);

    const result = await showCommand(makeParsed("show", [item.id]), makeFakeGateway());

    expect(result.status).toBe("success");
    if (result.status === "success") {
      expect(result.data.item.title).toBe("Specific task");
    }
  });

  test("returns error when id not found", async () => {
    const result = await showCommand(makeParsed("show", ["nonexistent"]), makeFakeGateway());
    expect(result.status).toBe("error");
    if (result.status === "error") {
      expect(result.message).toBeTruthy();
    }
  });

  test("omits cost block when no phase audit files exist", async () => {
    const item = makeItem({ type: "engineering" });
    await addItem(item);

    const result = await showCommand(makeParsed("show", [item.id]), makeFakeGateway());

    expect(result.status).toBe("success");
    if (result.status === "success") {
      expect(result.humanOutput).not.toContain("Cost & tokens");
      expect(result.data.cost.hasAnyData).toBe(false);
    }
  });

  test("includes per-phase cost breakdown when audit files have cost data", async () => {
    const item = makeItem({ type: "engineering" });
    await addItem(item);

    const planLine = JSON.stringify({
      type: "result",
      total_cost_usd: 0.5,
      usage: { input_tokens: 100, output_tokens: 200 },
      modelUsage: { "claude-opus-4-7": {} },
    });
    const executeLine = JSON.stringify({
      type: "result",
      total_cost_usd: 1.25,
      usage: { input_tokens: 500, output_tokens: 800 },
      modelUsage: { "claude-sonnet-4-6": {} },
    });

    const gateway = makeFakeGateway([
      phaseFile(item.id, "plan", [planLine], 1_000),
      phaseFile(item.id, "execute", [executeLine], 2_000),
    ]);

    const result = await showCommand(makeParsed("show", [item.id]), gateway);

    expect(result.status).toBe("success");
    if (result.status === "success") {
      expect(result.humanOutput).toContain("Cost & tokens:");
      expect(result.humanOutput).toContain("plan");
      expect(result.humanOutput).toContain("execute");
      expect(result.humanOutput).toContain("TOTAL");
      expect(result.humanOutput).toContain("$1.75");
      expect(result.data.cost.total.costUsd).toBeCloseTo(1.75, 6);
    }
  });

  test("orders phases by mtime (chronological)", async () => {
    const item = makeItem({ type: "engineering" });
    await addItem(item);

    // Provide them in non-chronological order in the fake gateway;
    // show should still output plan → execute → validate.
    const r = (cost: number) =>
      JSON.stringify({
        type: "result",
        total_cost_usd: cost,
        usage: { input_tokens: 1, output_tokens: 1 },
      });
    const gateway = makeFakeGateway([
      phaseFile(item.id, "validate", [r(0.3)], 3_000),
      phaseFile(item.id, "plan", [r(0.1)], 1_000),
      phaseFile(item.id, "execute", [r(0.2)], 2_000),
    ]);

    const result = await showCommand(makeParsed("show", [item.id]), gateway);
    expect(result.status).toBe("success");
    if (result.status === "success") {
      const phases = result.data.cost.phases.map((p) => p.phase);
      expect(phases).toEqual(["plan", "execute", "validate"]);
    }
  });
});
