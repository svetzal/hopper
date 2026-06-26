import { isRecord } from "./is-record.ts";

export type TerminalRunnerFailureKind = "account_limit";

export interface TerminalRunnerFailure {
  provider: "anthropic";
  failureKind: TerminalRunnerFailureKind;
  terminal: true;
  apiErrorStatus: number;
  message: string;
}

const ACCOUNT_LIMIT_PATTERN = /\b(monthly spend limit|spend limit|quota|account[-_\s]?limit)\b/i;

function hasAccountLimitWording(message: string): boolean {
  return ACCOUNT_LIMIT_PATTERN.test(message);
}

function describeFailureKind(failure: TerminalRunnerFailure): string {
  switch (failure.failureKind) {
    case "account_limit":
      return "monthly spend limit";
  }
}

export function classifyClaudeResultRecord(record: unknown): TerminalRunnerFailure | null {
  if (!isRecord(record)) return null;
  if (record.type !== "result") return null;
  if (record.is_error !== true) return null;
  if (record.api_error_status !== 429) return null;
  if (typeof record.result !== "string") return null;
  if (!hasAccountLimitWording(record.result)) return null;

  return {
    provider: "anthropic",
    failureKind: "account_limit",
    terminal: true,
    apiErrorStatus: 429,
    message: record.result,
  };
}

export function classifyTerminalRunnerFailureRecord(record: unknown): TerminalRunnerFailure | null {
  return classifyClaudeResultRecord(record);
}

export function extractClaudeTerminalFailure(jsonlOutput: string): TerminalRunnerFailure | null {
  let lastFailure: TerminalRunnerFailure | null = null;

  for (const line of jsonlOutput.split("\n")) {
    try {
      const parsed = JSON.parse(line) as unknown;
      const failure = classifyClaudeResultRecord(parsed);
      if (failure) {
        lastFailure = failure;
      }
    } catch {
      // Ignore non-JSON lines in mixed audit streams.
    }
  }

  return lastFailure;
}

export function formatTerminalRunnerFailureSummary(failure: TerminalRunnerFailure): string {
  return [
    `Terminal runner failure: ${failure.provider} ${failure.failureKind} (HTTP ${failure.apiErrorStatus} ${describeFailureKind(failure)})`,
    "",
    `Provider message: ${failure.message}`,
  ].join("\n");
}
