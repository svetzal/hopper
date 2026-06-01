import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { streamToAuditFile } from "./audit-stream.ts";

function makeStream(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(encoder.encode(chunk));
      }
      controller.close();
    },
  });
}

describe("streamToAuditFile", () => {
  let tempDir = "";

  afterEach(async () => {
    if (tempDir) {
      await rm(tempDir, { recursive: true, force: true });
      tempDir = "";
    }
  });

  async function setup(): Promise<string> {
    tempDir = await mkdtemp(join(tmpdir(), "audit-stream-test-"));
    return join(tempDir, "audit.jsonl");
  }

  test("returns all complete lines joined and writes them newline-terminated to file", async () => {
    const auditFile = await setup();
    const stream = makeStream(['{"a":1}\n{"b":2}\n']);
    const result = await streamToAuditFile(stream, auditFile, "");

    expect(result).toBe('{"a":1}\n{"b":2}');
    const content = await readFile(auditFile, "utf8");
    expect(content).toBe('{"a":1}\n{"b":2}\n');
  });

  test("flushes and returns a non-newline-terminated trailing remainder", async () => {
    const auditFile = await setup();
    const stream = makeStream(['{"a":1}\n{"partial"']);
    const result = await streamToAuditFile(stream, auditFile, "");

    expect(result).toBe('{"a":1}\n{"partial"');
    const content = await readFile(auditFile, "utf8");
    // Complete line written with newline; remainder flushed without newline
    expect(content).toBe('{"a":1}\n{"partial"');
  });

  test("writes preamble before stream content when preamble is non-empty", async () => {
    const auditFile = await setup();
    const preamble = '{"type":"session-separator"}\n';
    const stream = makeStream(['{"a":1}\n']);
    await streamToAuditFile(stream, auditFile, preamble);

    const content = await readFile(auditFile, "utf8");
    expect(content).toBe('{"type":"session-separator"}\n{"a":1}\n');
  });

  test("empty preamble writes no leading bytes before stream content", async () => {
    const auditFile = await setup();
    const stream = makeStream(['{"x":1}\n']);
    await streamToAuditFile(stream, auditFile, "");

    const content = await readFile(auditFile, "utf8");
    expect(content).toBe('{"x":1}\n');
  });

  test("reassembles lines split across chunk boundaries", async () => {
    const auditFile = await setup();
    // Split a single JSON line across two chunks to verify remainder handling
    const stream = makeStream(['{"split":', '"yes"}\n']);
    const result = await streamToAuditFile(stream, auditFile, "");

    expect(result).toBe('{"split":"yes"}');
    const content = await readFile(auditFile, "utf8");
    expect(content).toBe('{"split":"yes"}\n');
  });
});
