import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAuditGateway } from "./audit-gateway.ts";

const ITEM_ID = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";

describe("AuditGateway", () => {
  let tempDir: string;

  afterEach(async () => {
    if (tempDir) {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  async function setup() {
    tempDir = await mkdtemp(join(tmpdir(), "audit-gw-"));
    return createAuditGateway(tempDir);
  }

  async function setupWithAuditDir() {
    tempDir = await mkdtemp(join(tmpdir(), "audit-gw-"));
    const auditDir = join(tempDir, "audit");
    await Bun.write(join(auditDir, ".keep"), ""); // creates the directory via write
    return { gateway: createAuditGateway(tempDir), auditDir };
  }

  // ── listPhaseFiles ───────────────────────────────────────────────────────

  test("listPhaseFiles returns [] when audit directory does not exist", async () => {
    const gateway = await setup();
    const files = await gateway.listPhaseFiles(ITEM_ID);
    expect(files).toEqual([]);
  });

  test("listPhaseFiles returns [] when no matching files exist", async () => {
    const { gateway, auditDir } = await setupWithAuditDir();
    // Write a file that belongs to a different item
    await Bun.write(join(auditDir, "other-item-id-audit.jsonl"), "");
    const files = await gateway.listPhaseFiles(ITEM_ID);
    expect(files).toEqual([]);
  });

  test("listPhaseFiles returns only matching JSONL files for the given item", async () => {
    const { gateway, auditDir } = await setupWithAuditDir();

    await Bun.write(join(auditDir, `${ITEM_ID}-audit.jsonl`), '{"type":"start"}\n');
    await Bun.write(join(auditDir, `${ITEM_ID}-plan.jsonl`), '{"type":"start"}\n');
    await Bun.write(join(auditDir, `${ITEM_ID}-execute.jsonl`), '{"type":"start"}\n');
    await Bun.write(join(auditDir, `${ITEM_ID}-execute-2.jsonl`), '{"type":"start"}\n');
    await Bun.write(join(auditDir, `${ITEM_ID}-validate.jsonl`), '{"type":"start"}\n');
    await Bun.write(join(auditDir, `${ITEM_ID}-validate-2.jsonl`), '{"type":"start"}\n');
    // Markdown files should NOT be returned
    await Bun.write(join(auditDir, `${ITEM_ID}-plan.md`), "# Plan");
    await Bun.write(join(auditDir, `${ITEM_ID}-result.md`), "Done");
    // Different item — should NOT be returned
    await Bun.write(join(auditDir, "other-id-audit.jsonl"), "");

    const files = await gateway.listPhaseFiles(ITEM_ID);

    const names = files.map((f) => f.name).sort();
    expect(names).toEqual([
      `${ITEM_ID}-audit.jsonl`,
      `${ITEM_ID}-execute-2.jsonl`,
      `${ITEM_ID}-execute.jsonl`,
      `${ITEM_ID}-plan.jsonl`,
      `${ITEM_ID}-validate-2.jsonl`,
      `${ITEM_ID}-validate.jsonl`,
    ]);
  });

  test("listPhaseFiles includes mtimeMs and path for each file", async () => {
    const { gateway, auditDir } = await setupWithAuditDir();
    const filePath = join(auditDir, `${ITEM_ID}-audit.jsonl`);
    await Bun.write(filePath, '{"type":"start"}\n');

    const files = await gateway.listPhaseFiles(ITEM_ID);

    expect(files).toHaveLength(1);
    const file = files[0];
    expect(file).toBeDefined();
    if (file) {
      expect(file.path).toBe(filePath);
      expect(file.name).toBe(`${ITEM_ID}-audit.jsonl`);
      expect(typeof file.mtimeMs).toBe("number");
      expect(file.mtimeMs).toBeGreaterThan(0);
    }
  });

  // ── readJsonlLines ───────────────────────────────────────────────────────

  test("readJsonlLines returns null when file does not exist", async () => {
    const gateway = await setup();
    const result = await gateway.readJsonlLines(join(tempDir, "nonexistent.jsonl"));
    expect(result).toBeNull();
  });

  test("readJsonlLines returns lines and mtimeMs for existing file", async () => {
    const { gateway, auditDir } = await setupWithAuditDir();
    const filePath = join(auditDir, `${ITEM_ID}-audit.jsonl`);
    await Bun.write(filePath, '{"type":"start"}\n{"type":"result","result":"ok"}\n');

    const result = await gateway.readJsonlLines(filePath);

    expect(result).not.toBeNull();
    if (result) {
      expect(result.lines).toHaveLength(2);
      expect(result.lines[0]).toBe('{"type":"start"}');
      expect(result.lines[1]).toBe('{"type":"result","result":"ok"}');
      expect(typeof result.mtimeMs).toBe("number");
      expect(result.mtimeMs).toBeGreaterThan(0);
    }
  });

  test("readJsonlLines filters blank lines", async () => {
    const { gateway, auditDir } = await setupWithAuditDir();
    const filePath = join(auditDir, `${ITEM_ID}-audit.jsonl`);
    await Bun.write(filePath, '{"type":"start"}\n\n{"type":"result","result":"ok"}\n\n');

    const result = await gateway.readJsonlLines(filePath);

    expect(result?.lines).toHaveLength(2);
  });

  // ── readMarkdown ─────────────────────────────────────────────────────────

  test("readMarkdown returns null when file does not exist", async () => {
    const gateway = await setup();
    const result = await gateway.readMarkdown(join(tempDir, "no-such.md"));
    expect(result).toBeNull();
  });

  test("readMarkdown round-trips markdown content", async () => {
    const { gateway, auditDir } = await setupWithAuditDir();
    const filePath = join(auditDir, `${ITEM_ID}-plan.md`);
    const content = "# Plan\n\nDo the thing.";
    await Bun.write(filePath, content);

    const result = await gateway.readMarkdown(filePath);

    expect(result).toBe(content);
  });

  // ── paths ────────────────────────────────────────────────────────────────

  test("paths returns correct plan, result, and auditDir paths", async () => {
    const gateway = await setup();
    const p = gateway.paths(ITEM_ID);

    expect(p.auditDir).toBe(join(tempDir, "audit"));
    expect(p.plan).toBe(join(tempDir, "audit", `${ITEM_ID}-plan.md`));
    expect(p.result).toBe(join(tempDir, "audit", `${ITEM_ID}-result.md`));
  });
});
