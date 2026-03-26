import { describe, expect, test } from "bun:test";
import type { CommandResult } from "./command-result.ts";

describe("CommandResult", () => {
  test("success variant carries data and humanOutput", () => {
    const result: CommandResult = {
      status: "success",
      data: { id: "abc" },
      humanOutput: "Done",
    };
    expect(result.status).toBe("success");
    if (result.status === "success") {
      expect(result.data).toEqual({ id: "abc" });
      expect(result.humanOutput).toBe("Done");
      expect(result.warnings).toBeUndefined();
    }
  });

  test("success variant can carry optional warnings", () => {
    const result: CommandResult = {
      status: "success",
      data: [],
      humanOutput: "Listed",
      warnings: ["warning one", "warning two"],
    };
    if (result.status === "success") {
      expect(result.warnings).toEqual(["warning one", "warning two"]);
    }
  });

  test("error variant carries message", () => {
    const result: CommandResult = {
      status: "error",
      message: "Something went wrong",
    };
    expect(result.status).toBe("error");
    if (result.status === "error") {
      expect(result.message).toBe("Something went wrong");
      expect(result.exitCode).toBeUndefined();
    }
  });

  test("error variant carries optional exitCode", () => {
    const result: CommandResult = {
      status: "error",
      message: "Bad usage",
      exitCode: 2,
    };
    if (result.status === "error") {
      expect(result.exitCode).toBe(2);
    }
  });
});
