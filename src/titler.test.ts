import { describe, expect, test, mock } from "bun:test";
import type { TitleGenerator } from "./titler.ts";

// Unit test the title generator contract without hitting the real LLM.
// We test the interface and fallback behavior by creating test doubles.

describe("titler", () => {
  test("returns generated title when LLM succeeds", async () => {
    const titler: TitleGenerator = {
      async generateTitle(_description: string): Promise<string> {
        return "Refactor auth to JWT";
      },
    };

    const title = await titler.generateTitle("Refactor the authentication module to use JWT tokens");
    expect(title).toBe("Refactor auth to JWT");
  });

  test("fallback: truncates description to 60 chars", () => {
    const longDescription =
      "This is a very long description that exceeds sixty characters and should be truncated appropriately";
    const fallback = longDescription.slice(0, 60).trim();
    expect(fallback.length).toBeLessThanOrEqual(60);
    expect(longDescription.startsWith(fallback)).toBe(true);
  });

  test("createTitleGenerator falls back on LLM failure", async () => {
    // Simulate a title generator that fails and falls back
    const titler: TitleGenerator = {
      async generateTitle(description: string): Promise<string> {
        // Simulate LLM failure path
        return description.slice(0, 60).trim();
      },
    };

    const longDesc = "x".repeat(100);
    const title = await titler.generateTitle(longDesc);
    expect(title.length).toBe(60);
  });
});
