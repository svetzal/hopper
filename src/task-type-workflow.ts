import type { ClaudeSessionOptions } from "./gateways/claude-argv.ts";
import type { Item } from "./store.ts";

export type EngineeringPhase = "plan" | "execute" | "validate";

/**
 * Read-only tool set for investigation work.
 *
 * No Edit/Write/Bash so the session cannot mutate the filesystem even if the
 * prompt attempts to. Plan-mode permission (set in {@link buildInvestigationOptions})
 * is an additional belt-and-suspenders layer on top of this allowlist.
 */
export const INVESTIGATION_TOOLS: readonly string[] = [
  "Read",
  "Grep",
  "Glob",
  "WebFetch",
  "WebSearch",
  "Task",
];

/**
 * Build the prompt for an investigation item.
 *
 * The deliverable is the final assistant message — a markdown findings report
 * that Hopper captures into the item's `result` field.
 */
export function buildInvestigationPrompt(item: Item): string {
  return (
    `You have been assigned an INVESTIGATION task. Your deliverable is a written findings report in markdown — NOT code changes.\n\n` +
    `Title: ${item.title}\n` +
    `Description: ${item.description}\n\n` +
    `## Instructions\n\n` +
    `1. Read and analyze source, docs, and any other references needed to answer the question.\n` +
    `2. You have READ-ONLY tools only. Do not attempt to edit, write, or execute shell commands.\n` +
    `3. Produce your final response as a markdown findings report. Use headings, bullets, and fenced code snippets as appropriate.\n` +
    `4. Cite specific files and line numbers where relevant (e.g. \`src/foo.ts:42\`).\n` +
    `5. Be concrete and actionable. Flag uncertainty explicitly rather than guessing.\n\n` +
    `Your final message will be captured verbatim as the investigation result.\n`
  );
}

/**
 * Resolve the Claude session options for an investigation run.
 *
 * - Opus for strong reasoning on open-ended questions.
 * - Plan-mode permission so no mutating tools can fire.
 * - Explicit read-only tool allowlist as an additional constraint.
 */
export function buildInvestigationOptions(): ClaudeSessionOptions {
  return {
    model: "opus",
    permissionMode: "plan",
    tools: [...INVESTIGATION_TOOLS],
  };
}

// ---------------------------------------------------------------------------
// Engineering phase: plan
// ---------------------------------------------------------------------------

/**
 * Read-only tool set for the plan phase. Explicitly excludes Write/Edit so the
 * plan text can only be emitted as the final assistant message — not written
 * anywhere in the worktree. Hopper captures it and persists it under
 * `~/.hopper/audit/<id>-plan.md`.
 */
export const PLAN_TOOLS: readonly string[] = [
  "Read",
  "Grep",
  "Glob",
  "WebFetch",
  "WebSearch",
  "Task",
];

export function buildPlanPrompt(item: Item): string {
  return (
    `You are the PLANNING phase of a multi-phase engineering workflow.\n\n` +
    `Title: ${item.title}\n` +
    `Description: ${item.description}\n\n` +
    `## Instructions\n\n` +
    `1. Analyse the task and emit a plan as your final response. Do NOT write any files — you do not have Write/Edit tools.\n` +
    `2. Cover:\n` +
    `   - **Approach** — the engineering strategy in a few sentences.\n` +
    `   - **Files to touch** — specific paths, with what changes in each.\n` +
    `   - **Risks** — what could break; how to detect it.\n` +
    `   - **Validation commands** — the exact test / lint / type-check commands the Validate phase must run, with expected outcomes.\n` +
    `3. Be concrete. Cite file paths and line numbers (e.g. \`src/foo.ts:42\`).\n` +
    `4. Your final message is captured verbatim and inlined into the Execute and Validate phase prompts.\n`
  );
}

export function buildPlanOptions(): ClaudeSessionOptions {
  return {
    model: "opus",
    permissionMode: "plan",
    tools: [...PLAN_TOOLS],
  };
}

// ---------------------------------------------------------------------------
// Engineering phase: execute
// ---------------------------------------------------------------------------

/**
 * Tools the execute phase may NOT use. Every git mutation is owned by Hopper,
 * so the agent is explicitly denied any `git` invocation through Bash. Read
 * access is fine (`git diff`, `git log`) but mutating commands are blocked via
 * a disallow list — the caller's Claude config may add more tools, but none of
 * these will fire.
 *
 * NOTE: Claude's disallow list is prefix-matched against tool input patterns
 * like `Bash(git commit:*)`. We deny the full `Bash(git ...)` namespace because
 * any mutating git call during execute would leak out of Hopper's control.
 */
export const EXECUTE_DISALLOWED_TOOLS: readonly string[] = [
  "Bash(git commit:*)",
  "Bash(git add:*)",
  "Bash(git push:*)",
  "Bash(git merge:*)",
  "Bash(git rebase:*)",
  "Bash(git reset:*)",
  "Bash(git checkout:*)",
  "Bash(git switch:*)",
  "Bash(git branch:*)",
  "Bash(git tag:*)",
  "Bash(git stash:*)",
  "Bash(git cherry-pick:*)",
];

export function buildExecutePrompt(item: Item, planText: string): string {
  return (
    `You are the EXECUTE phase of a multi-phase engineering workflow.\n\n` +
    `Title: ${item.title}\n` +
    `Description: ${item.description}\n\n` +
    `## Plan (from the planning phase)\n\n` +
    `${planText}\n\n` +
    `## Instructions\n\n` +
    `1. Follow the plan above. Implement the changes in the current worktree.\n` +
    `2. Do NOT commit, push, branch, merge, stash, reset, or otherwise mutate git state — Hopper owns all git operations.\n` +
    `3. You may read git state (\`git diff\`, \`git log\`, \`git status\`) for context, but do not mutate it.\n` +
    `4. Stop when the code and tests are in place. The next phase (Validate) will run the plan's validation commands.\n` +
    `5. Provide a short summary of what you changed in your final message.\n`
  );
}

export function buildExecuteOptions(agent?: string): ClaudeSessionOptions {
  return {
    model: "sonnet",
    ...(agent ? { agent } : {}),
    disallowedTools: [...EXECUTE_DISALLOWED_TOOLS],
  };
}

/**
 * Build the prompt for a remediation pass after the validate phase failed.
 *
 * The remediation session keeps the same tool profile as the initial execute
 * phase (sonnet + craftsperson + git-mutation denylist) — the only thing that
 * changes is the prompt, which inlines what the earlier execute attempt
 * claimed to do plus the validate failure output, so the agent can target the
 * regression rather than redoing work that already succeeded.
 */
export function buildExecuteRemediationPrompt(
  item: Item,
  planText: string,
  priorExecuteResult: string,
  priorValidateResult: string,
  attempt: number,
): string {
  return (
    `You are the EXECUTE phase of a multi-phase engineering workflow. ` +
    `This is remediation attempt ${attempt} — an earlier execute pass completed, ` +
    `but the validate phase that followed reported failures.\n\n` +
    `Title: ${item.title}\n` +
    `Description: ${item.description}\n\n` +
    `## Plan (from the planning phase)\n\n` +
    `${planText}\n\n` +
    `## What the previous execute attempt reported\n\n` +
    `${priorExecuteResult}\n\n` +
    `## Validate-phase failure output\n\n` +
    `${priorValidateResult}\n\n` +
    `## Instructions\n\n` +
    `1. Focus on fixing ONLY the issues surfaced by the validate phase. Do not redo changes that already landed correctly.\n` +
    `2. Do NOT commit, push, branch, merge, stash, reset, or otherwise mutate git state — Hopper owns all git operations.\n` +
    `3. You may read git state (\`git diff\`, \`git log\`, \`git status\`) to see what's already in the worktree.\n` +
    `4. Stop when the fixes are in place. Validate will run again after you return.\n` +
    `5. Provide a short summary of what you changed in this attempt.\n`
  );
}

// ---------------------------------------------------------------------------
// Engineering phase: validate
// ---------------------------------------------------------------------------

/**
 * The validate phase can inspect git state and run tests/lint, but cannot
 * mutate anything. Read-only git commands only; Hopper owns all mutations.
 *
 * Test/lint/build commands are intentionally broad (`Bash(bun *:*)`, etc.) —
 * the specific commands come from the plan text. Narrowing further would mean
 * guessing the project's tooling.
 */
export const VALIDATE_ALLOWED_TOOLS: readonly string[] = [
  "Bash(git diff:*)",
  "Bash(git status:*)",
  "Bash(git log:*)",
  "Bash(git show:*)",
];

export const VALIDATE_TOOLS: readonly string[] = ["Read", "Grep", "Glob", "Bash", "Task"];

export function buildValidatePrompt(item: Item, planText: string): string {
  return (
    `You are the VALIDATE phase of a multi-phase engineering workflow.\n\n` +
    `Title: ${item.title}\n` +
    `Description: ${item.description}\n\n` +
    `## Plan (from the planning phase)\n\n` +
    `${planText}\n\n` +
    `## Instructions\n\n` +
    `1. Run the validation commands listed in the plan (test suite, linter, type checker, any project-specific checks).\n` +
    `2. Inspect the diff with \`git diff\` / \`git log\` / \`git status\` / \`git show\` to judge whether the worktree now satisfies the plan.\n` +
    `3. Do not mutate git state — no commit, branch, checkout, merge, reset, or push. Hopper owns all git mutations.\n` +
    `4. If validation fails, report which checks failed with their output. Only fix trivial issues (e.g. an unused import) yourself — anything larger is a signal to requeue.\n` +
    `5. End your final message with one of these exact tokens on its own line:\n` +
    `   - \`VALIDATE: PASS\` — all checks passed and the diff satisfies the plan.\n` +
    `   - \`VALIDATE: FAIL\` — something is wrong; include the failure details above.\n`
  );
}

export function buildValidateOptions(): ClaudeSessionOptions {
  return {
    model: "opus",
    tools: [...VALIDATE_TOOLS],
    allowedTools: [...VALIDATE_ALLOWED_TOOLS],
    disallowedTools: [...EXECUTE_DISALLOWED_TOOLS],
  };
}

/**
 * Decide whether the validate phase's final message indicates success.
 *
 * We look for the VALIDATE: PASS / FAIL token in the result. Ambiguous or
 * missing output is treated as a failure — we'd rather requeue than merge
 * something unverified.
 */
export function resolveValidateOutcome(
  exitCode: number,
  resultText: string,
): { passed: boolean; reason: string } {
  if (exitCode !== 0) {
    return { passed: false, reason: `Validate phase exited ${exitCode}` };
  }
  const passMatch = /^VALIDATE:\s*PASS\s*$/m.test(resultText);
  const failMatch = /^VALIDATE:\s*FAIL\s*$/m.test(resultText);
  if (passMatch && !failMatch) return { passed: true, reason: "validate reported PASS" };
  if (failMatch) return { passed: false, reason: "validate reported FAIL" };
  return { passed: false, reason: "validate phase did not emit a PASS/FAIL marker" };
}

// ---------------------------------------------------------------------------
// Haiku one-shot helpers (branch slug + commit message)
// ---------------------------------------------------------------------------

export function buildBranchSlugPrompt(title: string, description: string): string {
  return (
    `Produce a short kebab-case slug (3–5 words, ASCII letters/digits/hyphens only) that captures the essence of this engineering task. ` +
    `Respond with ONLY the slug — no quotes, no explanation, no trailing punctuation.\n\n` +
    `Title: ${title}\n` +
    `Description: ${description}\n`
  );
}

/**
 * Normalise a raw Haiku response into a safe kebab-case slug.
 *
 * Returns `null` when the response cannot be coerced into something usable —
 * the caller should then fall back to the deterministic `<id-prefix>` branch
 * name.
 */
export function normaliseBranchSlug(raw: string): string | null {
  const cleaned = raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (!cleaned) return null;
  // Cap slug length so branch names stay readable.
  const truncated = cleaned.slice(0, 60).replace(/-+$/, "");
  return truncated || null;
}

export function buildCommitMessagePrompt(
  title: string,
  description: string,
  diffSummary: string,
): string {
  return (
    `Write a conventional-commit-style message for the changes below. ` +
    `First line: short imperative subject (≤ 72 chars). Blank line. Body: 1–3 short lines summarising what changed and why. ` +
    `Respond with ONLY the commit message text — no code fences, no preamble.\n\n` +
    `Task title: ${title}\n` +
    `Task description: ${description}\n\n` +
    `Diff summary:\n${diffSummary}\n`
  );
}

/**
 * Strip common LLM response artifacts (fenced code blocks, leading "Commit:"
 * labels) from a Haiku-generated commit message.
 */
export function normaliseCommitMessage(raw: string): string {
  let text = raw.trim();
  // Drop surrounding ```...``` fences if present.
  const fence = text.match(/^```[a-zA-Z]*\n([\s\S]*?)\n```$/);
  if (fence?.[1]) text = fence[1].trim();
  // Drop common "Subject: " / "Commit: " prefixes.
  text = text.replace(/^(?:Subject|Commit message|Commit):\s*/i, "");
  return text.trim();
}
