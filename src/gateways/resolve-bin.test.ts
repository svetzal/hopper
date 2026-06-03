import { describe, expect, test } from "bun:test";
import { resolveBinOnPath } from "./resolve-bin.ts";

describe("resolveBinOnPath", () => {
  test("returns a non-empty path for a known binary", () => {
    const result = resolveBinOnPath("sh", "Install sh.");
    expect(result).toBeTruthy();
    expect(typeof result).toBe("string");
  });

  test("throws with binary name and install hint when not found", () => {
    expect(() =>
      resolveBinOnPath(
        "hopper-nonexistent-bin-xyz",
        "Install hopper-nonexistent-bin-xyz to continue.",
      ),
    ).toThrow(
      "hopper-nonexistent-bin-xyz executable not found on PATH. Install hopper-nonexistent-bin-xyz to continue.",
    );
  });
});
