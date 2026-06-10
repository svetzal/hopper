import { StaleEngineeringBranchError } from "./engineering-errors.ts";
import { toErrorMessage } from "./error-utils.ts";
import { normaliseCommitMessage } from "./task-type-workflow.ts";

/**
 * Verify that an engineering item carries the metadata required to run inside
 * an isolated worktree. The add command enforces this on enqueue; this guard
 * is a belt-and-suspenders check in the worker.
 */
export function resolveEngineeringPreconditions(item: {
  workingDir?: string;
  branch?: string;
}): { ok: true; workingDir: string; branch: string } | { ok: false; reason: string } {
  if (!item.workingDir || !item.branch) {
    return {
      ok: false,
      reason: "Engineering items require --dir and --branch; cannot run.",
    };
  }
  return { ok: true, workingDir: item.workingDir, branch: item.branch };
}

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
 * Classify a worktree-setup exception as a human-readable requeue reason.
 * Pure — no I/O, suitable for use in catch blocks before dispatching to safeRequeue.
 */
export function resolveWorktreeSetupFailureReason(e: unknown): string {
  return e instanceof StaleEngineeringBranchError
    ? `Stale branch: ${e.message}`
    : `Worktree setup failed: ${toErrorMessage(e)}`;
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
