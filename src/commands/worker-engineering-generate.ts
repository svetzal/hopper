import { resolveEngineeringCommitFallback } from "../engineering-workflow.ts";
import { toErrorMessage } from "../error-utils.ts";
import type { AgentRunner } from "../gateways/agent-runner.ts";
import type { Profile } from "../profile.ts";
import type { Item } from "../store.ts";
import {
  buildBranchSlugPrompt,
  buildCommitMessagePrompt,
  buildValidateFallbackPrompt,
  MISSING_MARKER_REASON,
  normaliseBranchSlug,
  normaliseValidateFallback,
  resolveValidateOutcome,
} from "../task-type-workflow.ts";
import type { LogFn } from "./worker-orchestration.ts";

export async function safeGenerateText(
  claude: AgentRunner,
  prompt: string,
  profile: Profile,
  label: string,
  log: LogFn,
): Promise<{ ok: true; text: string } | { ok: false }> {
  try {
    const { exitCode, text } = await claude.generateText(prompt, "fast", { profile });
    if (exitCode !== 0) {
      log(`${label} failed (exit ${exitCode})`);
      return { ok: false };
    }
    return { ok: true, text };
  } catch (e) {
    log(`${label} failed: ${toErrorMessage(e)}`);
    return { ok: false };
  }
}

export async function resolveEngineeringBranchSlug(
  claude: AgentRunner,
  profile: Profile,
  item: Item,
  log: LogFn,
): Promise<string | null> {
  const prompt = buildBranchSlugPrompt(item.title, item.description);
  const result = await safeGenerateText(claude, prompt, profile, "Branch slug generation", log);
  if (!result.ok) return null;
  return normaliseBranchSlug(result.text);
}

export async function resolveEngineeringCommitMessage(
  claude: AgentRunner,
  profile: Profile,
  item: Item,
  diffSummary: string,
  log: LogFn,
): Promise<string> {
  const prompt = buildCommitMessagePrompt(item.title, item.description, diffSummary);
  const result = await safeGenerateText(claude, prompt, profile, "Commit message generation", log);
  if (!result.ok) return item.title;
  return resolveEngineeringCommitFallback(item, result.text, 0);
}

const FALLBACK_UNCLASSIFIED_REASON = "fallback assessor could not classify (defaulting to FAIL)";

const fallbackFailOutcome = (): { passed: false; reason: string; fallbackUsed: true } => ({
  passed: false,
  reason: FALLBACK_UNCLASSIFIED_REASON,
  fallbackUsed: true,
});

export async function resolveValidateOutcomeWithFallback(
  exitCode: number,
  resultText: string,
  claude: Pick<AgentRunner, "generateText">,
  profile: Profile,
  log: LogFn = () => {},
): Promise<{ passed: boolean; reason: string; fallbackUsed?: boolean }> {
  const primary = resolveValidateOutcome(exitCode, resultText);

  if (primary.reason !== MISSING_MARKER_REASON) {
    return primary;
  }

  log("Validate marker missing — invoking fast fallback assessor...");

  try {
    const { exitCode: fallbackExitCode, text } = await claude.generateText(
      buildValidateFallbackPrompt(resultText),
      "fast",
      { profile },
    );

    if (fallbackExitCode !== 0) {
      log("Fallback assessor exited non-zero — defaulting to FAIL.");
      return fallbackFailOutcome();
    }

    const verdict = normaliseValidateFallback(text);

    if (verdict === "PASS") {
      log("Fallback assessor reported PASS.");
      return { passed: true, reason: "fallback assessor reported PASS", fallbackUsed: true };
    }

    if (verdict === "FAIL") {
      log("Fallback assessor reported FAIL.");
      return { passed: false, reason: "fallback assessor reported FAIL", fallbackUsed: true };
    }

    log("Fallback assessor was UNCLEAR — defaulting to FAIL.");
    return fallbackFailOutcome();
  } catch {
    log("Fallback assessor threw — defaulting to FAIL.");
    return fallbackFailOutcome();
  }
}
