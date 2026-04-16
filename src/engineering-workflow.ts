import { normaliseCommitMessage } from "./task-type-workflow.ts";

/**
 * Compose the result markdown for an engineering attempt transcript, with a
 * section per execute/validate pair so coordinators reviewing `hopper show`
 * or `<id>-result.md` can see how each remediation attempt unfolded.
 */
export function buildEngineeringTranscript(
  planText: string,
  executeResults: readonly string[],
  validateResults: readonly string[],
): string {
  const sections: string[] = ["## Plan", planText];
  const pairs = Math.max(executeResults.length, validateResults.length);
  for (let i = 0; i < pairs; i++) {
    const label = pairs > 1 ? ` (attempt ${i + 1})` : "";
    if (executeResults[i] !== undefined) {
      sections.push(`## Execute${label}`, executeResults[i] ?? "");
    }
    if (validateResults[i] !== undefined) {
      sections.push(`## Validate${label}`, validateResults[i] ?? "");
    }
  }
  return sections.join("\n\n");
}

export function buildEngineeringFailureResult(
  planText: string,
  executeResults: readonly string[],
  validateResults: readonly string[],
  failureMessage: string,
): string {
  return `${buildEngineeringTranscript(planText, executeResults, validateResults)}\n\n${failureMessage}`;
}

/**
 * Given the raw text and exit code from a Haiku commit-message generation call,
 * return the normalised commit message, falling back to the item title when
 * the LLM call did not succeed or produced empty output.
 */
export function resolveEngineeringCommitFallback(
  item: { title: string },
  text: string,
  exitCode: number,
): string {
  if (exitCode === 0 && text.trim()) {
    return normaliseCommitMessage(text);
  }
  return item.title;
}
