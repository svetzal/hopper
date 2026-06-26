import { describe, expect, test } from "bun:test";
import {
  classifyClaudeResultRecord,
  extractClaudeTerminalFailure,
  formatTerminalRunnerFailureSummary,
} from "./runner-terminal-failure.ts";

const ACCOUNT_LIMIT_RECORD = {
  type: "result",
  is_error: true,
  api_error_status: 429,
  result: "You've hit your monthly spend limit - raise it at claude.ai/settings/usage",
} as const;

describe("runner-terminal-failure", () => {
  test("classifies Claude monthly spend limit result records as terminal account_limit failures", () => {
    expect(classifyClaudeResultRecord(ACCOUNT_LIMIT_RECORD)).toEqual({
      provider: "anthropic",
      failureKind: "account_limit",
      terminal: true,
      apiErrorStatus: 429,
      message: "You've hit your monthly spend limit - raise it at claude.ai/settings/usage",
    });
  });

  test("does not classify generic 429 rate limits without account-limit wording", () => {
    expect(
      classifyClaudeResultRecord({
        type: "result",
        is_error: true,
        api_error_status: 429,
        result: "Rate limit exceeded, try again later.",
      }),
    ).toBeNull();
  });

  test("ignores malformed and non-result lines while extracting the last terminal failure from JSONL", () => {
    const output = [
      "not json",
      JSON.stringify({ type: "system", subtype: "init" }),
      JSON.stringify({
        type: "result",
        is_error: true,
        api_error_status: 429,
        result: "Rate limit exceeded, try again later.",
      }),
      JSON.stringify(ACCOUNT_LIMIT_RECORD),
    ].join("\n");

    expect(extractClaudeTerminalFailure(output)).toEqual({
      provider: "anthropic",
      failureKind: "account_limit",
      terminal: true,
      apiErrorStatus: 429,
      message: "You've hit your monthly spend limit - raise it at claude.ai/settings/usage",
    });
  });

  test("formats a clear operator-facing summary", () => {
    const failure = classifyClaudeResultRecord(ACCOUNT_LIMIT_RECORD);
    expect(failure).not.toBeNull();
    if (!failure) {
      throw new Error("Expected account-limit record to classify");
    }
    expect(formatTerminalRunnerFailureSummary(failure)).toContain(
      "Terminal runner failure: anthropic account_limit (HTTP 429 monthly spend limit)",
    );
  });
});
