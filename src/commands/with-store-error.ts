import type { CommandResult } from "../command-result.ts";
import { toErrorMessage } from "../error-utils.ts";

export async function withStoreError(fn: () => Promise<CommandResult>): Promise<CommandResult> {
  try {
    return await fn();
  } catch (e) {
    return { status: "error", message: toErrorMessage(e) };
  }
}
