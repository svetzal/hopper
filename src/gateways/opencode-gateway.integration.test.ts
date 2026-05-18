/**
 * Integration test for the opencode AgentRunner.
 *
 * Runs the actual `opencode` CLI against a tiny deterministic prompt and
 * verifies the runner returns a parseable audit file, a non-empty result,
 * and a zero exit code. Skipped by default — opt in with:
 *
 *   HOPPER_OPENCODE_IT=1 bun test src/gateways/opencode-gateway.integration.test.ts
 *
 * Prerequisites:
 *   - `opencode` v1.15+ on PATH
 *   - At least one authenticated provider; defaults to `opencode/deepseek-v4-flash-free`
 *     which requires no credentials (override with HOPPER_OPENCODE_IT_MODEL)
 */
import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createOpencodeRunner } from "./opencode-gateway.ts";

const ENABLED = Boolean(process.env.HOPPER_OPENCODE_IT);
const MODEL = process.env.HOPPER_OPENCODE_IT_MODEL ?? "opencode/deepseek-v4-flash-free";
const it = ENABLED ? test : test.skip;

describe("opencode runner integration", () => {
  it("runs a session end-to-end, writes audit JSONL, and extracts the final result", async () => {
    const workDir = await mkdtemp(join(tmpdir(), "hopper-opencode-it-"));
    const auditFile = join(workDir, "audit.jsonl");

    try {
      const runner = createOpencodeRunner();
      const { exitCode, result } = await runner.runSession(
        "Respond with exactly the word PONG and nothing else.",
        workDir,
        auditFile,
        { model: MODEL },
      );

      expect(exitCode).toBe(0);
      expect(result.length).toBeGreaterThan(0);
      // Free models occasionally pad with whitespace; the substring check
      // is the most stable assertion the test can make about the body.
      expect(result.toUpperCase()).toContain("PONG");

      const audit = await readFile(auditFile, "utf8");
      const lines = audit.split("\n").filter((l) => l.trim().length > 0);
      expect(lines.length).toBeGreaterThan(0);

      const types = new Set<string>();
      let sessionID: string | undefined;
      for (const line of lines) {
        try {
          const ev = JSON.parse(line) as { type?: string; sessionID?: string };
          if (ev.type) types.add(ev.type);
          if (!sessionID && typeof ev.sessionID === "string") sessionID = ev.sessionID;
        } catch {
          // tolerate non-JSON lines (synthetic separator only emits json)
        }
      }

      expect(sessionID).toMatch(/^ses_/);
      expect(types.has("step_start")).toBe(true);
      expect(types.has("text")).toBe(true);
      // The runner appends a synthetic export event after the stream closes.
      expect(types.has("opencode-export")).toBe(true);
    } finally {
      await rm(workDir, { recursive: true, force: true });
    }
  }, 120_000);
});
