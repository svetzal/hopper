import { describe, expect, test } from "bun:test";
import { createConfirmGateway } from "./confirm-gateway.ts";

describe("createConfirmGateway", () => {
  test("fails closed (returns false without prompting) when stdin is not a TTY", async () => {
    // The bun:test runner is non-interactive — stdin.isTTY is falsy — so the
    // gateway must resolve false immediately rather than block on a prompt.
    const confirm = createConfirmGateway();
    const result = await confirm("Delete everything?");
    expect(result).toBe(false);
  });
});
