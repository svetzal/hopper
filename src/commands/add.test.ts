import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ParsedArgs } from "../cli.ts";
import { setStoreDir } from "../store.ts";
import type { TitleGenerator } from "../titler.ts";
import { addCommand } from "./add.ts";

function makeParsed(
  positional: string[] = [],
  flags: Record<string, string | boolean> = {},
  arrayFlags: Record<string, string[]> = {},
): ParsedArgs {
  return { command: "add", positional, flags, arrayFlags };
}

function makeTitler(title = "Generated Title"): TitleGenerator {
  return { generateTitle: mock(async (_desc: string) => title) };
}

describe("addCommand", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "hopper-add-test-"));
    setStoreDir(tempDir);
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true });
  });

  test("returns error when no description is provided", async () => {
    const result = await addCommand(makeParsed([]), makeTitler());

    expect(result.status).toBe("error");
    if (result.status === "error") {
      expect(result.message).toBeTruthy();
    }
  });

  test("returns success with added item", async () => {
    const result = await addCommand(makeParsed(["Fix the login bug"]), makeTitler());

    expect(result.status).toBe("success");
    if (result.status === "success") {
      expect(result.humanOutput).toContain("Added:");
    }
  });

  test("uses generated title in humanOutput", async () => {
    const result = await addCommand(makeParsed(["Fix the login bug"]), makeTitler("Fix Login Bug"));

    expect(result.status).toBe("success");
    if (result.status === "success") {
      expect(result.humanOutput).toContain("Fix Login Bug");
    }
  });

  test("returns error for invalid priority", async () => {
    const result = await addCommand(makeParsed(["A task"], { priority: "critical" }), makeTitler());

    expect(result.status).toBe("error");
  });

  test("returns error when --dir is set without --branch or --command", async () => {
    const result = await addCommand(makeParsed(["A task"], { dir: "/some/path" }), makeTitler());

    expect(result.status).toBe("error");
  });

  test("returns success with priority badge in humanOutput", async () => {
    const result = await addCommand(
      makeParsed(["A task"], { priority: "high" }),
      makeTitler("High Task"),
    );

    expect(result.status).toBe("success");
    if (result.status === "success") {
      expect(result.humanOutput).toContain("High Task");
    }
  });

  test("includes tags in humanOutput when provided", async () => {
    const result = await addCommand(
      makeParsed(["A task"], {}, { tag: ["frontend"] }),
      makeTitler("Frontend Task"),
    );

    expect(result.status).toBe("success");
    if (result.status === "success") {
      expect(result.humanOutput).toContain("[frontend]");
    }
  });

  test("returns error for invalid --every value", async () => {
    const result = await addCommand(
      makeParsed(["A task"], { every: "invalid-spec" }),
      makeTitler(),
    );

    expect(result.status).toBe("error");
  });
});
