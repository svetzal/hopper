import { describe, expect, test } from "bun:test";
import { withStoreError } from "./with-store-error.ts";

describe("withStoreError", () => {
  test("passes through a successful CommandResult unchanged", async () => {
    const result = await withStoreError(async () => ({
      status: "success",
      data: { foo: 1 },
      humanOutput: "ok",
    }));
    expect(result).toEqual({ status: "success", data: { foo: 1 }, humanOutput: "ok" });
  });

  test("wraps a thrown Error into an error CommandResult", async () => {
    const result = await withStoreError(async () => {
      throw new Error("something went wrong");
    });
    expect(result).toEqual({ status: "error", message: "something went wrong" });
  });

  test("wraps a non-Error throw into an error CommandResult", async () => {
    const result = await withStoreError(async () => {
      throw "plain string error";
    });
    expect(result).toEqual({ status: "error", message: "plain string error" });
  });
});
