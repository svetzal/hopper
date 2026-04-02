import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import type { TitleGenerator } from "../titler.ts";
import { addCommand } from "./add.ts";
import { makeParsed, setupTempStoreDir } from "./test-helpers.ts";

function makeTitler(title = "Generated Title"): TitleGenerator {
  return { generateTitle: mock(async (_desc: string) => title) };
}

describe("addCommand", () => {
  const storeDir = setupTempStoreDir("hopper-add-test-");

  beforeEach(storeDir.beforeEach);
  afterEach(storeDir.afterEach);

  test("returns error when no description is provided", async () => {
    const result = await addCommand(makeParsed("add", []), makeTitler(), async () => "");

    expect(result.status).toBe("error");
    if (result.status === "error") {
      expect(result.message).toBeTruthy();
    }
  });

  test("returns success with added item", async () => {
    const result = await addCommand(makeParsed("add", ["Fix the login bug"]), makeTitler());

    expect(result.status).toBe("success");
    if (result.status === "success") {
      expect(result.humanOutput).toContain("Added:");
    }
  });

  test("uses generated title in humanOutput", async () => {
    const result = await addCommand(
      makeParsed("add", ["Fix the login bug"]),
      makeTitler("Fix Login Bug"),
    );

    expect(result.status).toBe("success");
    if (result.status === "success") {
      expect(result.humanOutput).toContain("Fix Login Bug");
    }
  });

  test("returns error for invalid priority", async () => {
    const result = await addCommand(
      makeParsed("add", ["A task"], { priority: "critical" }),
      makeTitler(),
    );

    expect(result.status).toBe("error");
  });

  test("returns error when --dir is set without --branch or --command", async () => {
    const result = await addCommand(
      makeParsed("add", ["A task"], { dir: "/some/path" }),
      makeTitler(),
    );

    expect(result.status).toBe("error");
  });

  test("returns success with priority badge in humanOutput", async () => {
    const result = await addCommand(
      makeParsed("add", ["A task"], { priority: "high" }),
      makeTitler("High Task"),
    );

    expect(result.status).toBe("success");
    if (result.status === "success") {
      expect(result.humanOutput).toContain("High Task");
    }
  });

  test("includes tags in humanOutput when provided", async () => {
    const result = await addCommand(
      makeParsed("add", ["A task"], {}, { tag: ["frontend"] }),
      makeTitler("Frontend Task"),
    );

    expect(result.status).toBe("success");
    if (result.status === "success") {
      expect(result.humanOutput).toContain("[frontend]");
    }
  });

  test("returns error for invalid --every value", async () => {
    const result = await addCommand(
      makeParsed("add", ["A task"], { every: "invalid-spec" }),
      makeTitler(),
    );

    expect(result.status).toBe("error");
  });
});
