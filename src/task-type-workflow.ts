import { join } from "node:path";
import type { SessionOptions } from "./gateways/agent-runner.ts";
import type { Item } from "./store.ts";

/**
 * Shared preamble template for single-phase prompts.
 *
 * Emits: `${header}\n\nTitle: ...\nDescription: ...\n\n[## Plan...]\n\n[extraSections]## Instructions\n\n${instructions}`
 *
 * The optional `planText` inserts a `## Plan (from the planning phase)` section
 * between the description and the instructions heading — used by the execute
 * and validate phases.
 *
 * The optional `extraSections` slot is inserted after the plan section and before
 * `## Instructions` — used by the remediation prompt to inline prior-attempt context.
 */
function buildPhasePrompt(
  header: string,
  item: Item,
  instructions: string,
  planText?: string,
  extraSections?: string,
): string {
  const planSection = planText ? `## Plan (from the planning phase)\n\n${planText}\n\n` : "";
  return (
    `${header}\n\n` +
    `Title: ${item.title}\n` +
    `Description: ${item.description}\n\n` +
    planSection +
    (extraSections ?? "") +
    `## Instructions\n\n` +
    instructions
  );
}

export type EngineeringPhase = "plan" | "execute" | "validate";

/**
 * Tool set for investigation work.
 *
 * Bash is included so agents can query CLI state (`hopper show --json`,
 * `hopper audit`, `git log`, `jq`, etc.) that is essential for evidence-based
 * findings. Mutation is prevented by {@link INVESTIGATION_DISALLOWED_TOOLS}
 * rather than plan-mode — the denylist is the actual control surface.
 */
export const INVESTIGATION_TOOLS: readonly string[] = [
  "Read",
  "Grep",
  "Glob",
  "Bash",
  "WebFetch",
  "WebSearch",
  "Task",
];

/**
 * Git mutation commands shared between the execute and investigation denylists.
 *
 * Both {@link EXECUTE_DISALLOWED_TOOLS} and {@link INVESTIGATION_DISALLOWED_TOOLS}
 * compose from this list; investigation adds three extra entries (`git clean`,
 * `git reflog`, `git worktree`).
 */
const GIT_MUTATION_DENYLIST: readonly string[] = [
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

/**
 * Bash patterns that investigation sessions must not invoke.
 *
 * Uses the same Claude `disallowedTools` prefix-match syntax as
 * {@link EXECUTE_DISALLOWED_TOOLS} (e.g. `Bash(git commit:*)`). Each category
 * is grouped with a rationale comment. Read-only commands — `hopper show|list|
 * audit|history`, `git log|status|diff|show|rev-parse|blame`, `git worktree
 * list`, `jq`, standard POSIX read utilities, `foundry history|trace`, and
 * `evt query|aggregate` — are intentionally NOT denied.
 *
 * Note: `Bash(git branch:*)` blocks `git branch --list` as a side effect of
 * blocking `git branch -d|-D`. Use `git for-each-ref refs/heads` (read-only)
 * as the equivalent. Similarly `Bash(git stash:*)` blocks `git stash list`;
 * use `git log refs/stash` instead.
 *
 * Composes from {@link GIT_MUTATION_DENYLIST} plus three investigation-only entries.
 */
export const INVESTIGATION_DISALLOWED_TOOLS: readonly string[] = [
  // Git mutators — must not rewrite history or touch refs
  ...GIT_MUTATION_DENYLIST,
  "Bash(git clean:*)",
  "Bash(git reflog:*)",
  "Bash(git worktree:*)",

  // Hopper queue mutators — investigations are read-only against the queue
  "Bash(hopper add:*)",
  "Bash(hopper cancel:*)",
  "Bash(hopper requeue:*)",
  "Bash(hopper integrate:*)",
  "Bash(hopper edit:*)",
  "Bash(hopper tag:*)",
  "Bash(hopper untag:*)",
  "Bash(hopper preset:*)",
  "Bash(hopper claim:*)",
  "Bash(hopper complete:*)",
  "Bash(hopper init:*)",

  // Foundry/evt mutators — foundry history|trace and evt query|aggregate are
  // read-only and intentionally NOT denied
  "Bash(foundry run:*)",
  "Bash(foundry release:*)",
  "Bash(foundry iterate:*)",
  "Bash(foundry maintain:*)",
  "Bash(evt log:*)",

  // Package managers / installers — no environment mutation during investigation
  "Bash(npm install:*)",
  "Bash(npm i:*)",
  "Bash(bun install:*)",
  "Bash(bun add:*)",
  "Bash(pnpm add:*)",
  "Bash(pnpm install:*)",
  "Bash(yarn add:*)",
  "Bash(yarn install:*)",
  "Bash(pip install:*)",
  "Bash(uv pip:*)",
  "Bash(cargo install:*)",
  "Bash(brew install:*)",
  "Bash(brew upgrade:*)",

  // Network egress — denied by default; opt-in is a future enhancement.
  // `aws` is intentionally NOT listed here: Claude's `disallowedTools` is
  // leading-token-prefix-matched against the Bash invocation and cannot
  // express "allow reads, deny writes" — the aws read/write distinction
  // lives in the action, which is the 2nd token (`aws dynamodb get-item` vs.
  // `aws dynamodb put-item`), not the 1st. Pre-refusing all aws here would
  // block legitimate read-only investigation queries (e.g. `aws dynamodb
  // get-item`, `aws sts get-caller-identity`). The PATH-shim
  // (`buildAwsReadonlyShimScript` / `AWS_READONLY` in worker-shim-content.ts)
  // is the single source of truth for the aws read/write distinction and
  // still denies all mutating aws calls at the binary level.
  "Bash(curl:*)",
  "Bash(wget:*)",
  "Bash(gh:*)",
  "Bash(ssh:*)",
  "Bash(scp:*)",
  "Bash(rsync:*)",

  // Filesystem mutators — mkdir/touch/cp left allowed for /tmp scratch work
  "Bash(rm:*)",
  "Bash(mv:*)",
  "Bash(chmod:*)",
  "Bash(chown:*)",
  "Bash(ln:*)",
];

/**
 * Build the prompt for an investigation item.
 *
 * The deliverable is the final assistant message — a markdown findings report
 * that Hopper captures into the item's `result` field.
 */
export function buildInvestigationPrompt(item: Item): string {
  return buildPhasePrompt(
    "You have been assigned an INVESTIGATION task. Your deliverable is a written findings report in markdown — NOT code changes.",
    item,
    `1. Read and analyze source, docs, and any other references needed to answer the question.\n` +
      `2. You have read-only tools plus a sandboxed Bash with mutating commands denied. Do not attempt git mutations, hopper queue mutations, package installs, or network egress — they will be blocked. Use Bash to read queue/audit/git state (\`hopper show --json\`, \`hopper audit\`, \`git log\`, \`jq\`, etc.).\n` +
      `3. Produce your final response as a markdown findings report. Use headings, bullets, and fenced code snippets as appropriate.\n` +
      `4. Cite specific files and line numbers where relevant (e.g. \`src/foo.ts:42\`).\n` +
      `5. Be concrete and actionable. Flag uncertainty explicitly rather than guessing.\n\n` +
      `Your final message will be captured verbatim as the investigation result.\n`,
  );
}

/**
 * Resolve the Claude session options for an investigation run.
 *
 * - Opus for strong reasoning on open-ended questions.
 * - Bash included so agents can read CLI state (`hopper show --json`, `git log`, etc.).
 * - {@link INVESTIGATION_DISALLOWED_TOOLS} denylist is the mutation control surface —
 *   `permissionMode: "plan"` is intentionally absent.
 */
export function buildInvestigationOptions(): SessionOptions {
  return {
    model: "deep",
    effort: "high",
    tools: [...INVESTIGATION_TOOLS],
    disallowedTools: [...INVESTIGATION_DISALLOWED_TOOLS],
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
  return buildPhasePrompt(
    "You are the PLANNING phase of a multi-phase engineering workflow.",
    item,
    `1. Analyse the task and emit a plan as your final response. Do NOT write any files — you do not have Write/Edit tools.\n` +
      `2. Cover:\n` +
      `   - **Approach** — the engineering strategy in a few sentences.\n` +
      `   - **Files to touch** — specific paths, with what changes in each.\n` +
      `   - **Risks** — what could break; how to detect it.\n` +
      `   - **Validation commands** — the exact test / lint / type-check commands the Validate phase must run, with expected outcomes.\n` +
      `3. Be concrete. Cite file paths and line numbers (e.g. \`src/foo.ts:42\`).\n` +
      `4. Your final message is captured verbatim and inlined into the Execute and Validate phase prompts.\n`,
  );
}

export function buildPlanOptions(): SessionOptions {
  return {
    model: "deep",
    effort: "high",
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
 *
 * Composes from {@link GIT_MUTATION_DENYLIST}.
 */
export const EXECUTE_DISALLOWED_TOOLS: readonly string[] = [...GIT_MUTATION_DENYLIST];

/**
 * Single source of truth for the prose form of Hopper's git-ownership rule.
 * The machine-enforced form is {@link EXECUTE_DISALLOWED_TOOLS}.
 */
export const GIT_OWNERSHIP_INSTRUCTION =
  "Do NOT commit or otherwise mutate git state. Do not fetch, pull, checkout, switch, create branches or worktrees, add, push, merge, rebase, tag, stash, or reset — Hopper owns the complete git lifecycle. If the task description asks for any of those operations, treat that clause as out of scope and continue with the requested code or documentation changes.";

/** Build the cross-runner environment that enforces Hopper's git ownership. */
export function buildGitOwnershipShimEnv(
  hopperHome: string,
  realPath: string,
): { HOPPER_REAL_PATH: string; PATH: string } {
  const shimDir = join(hopperHome, "git-ownership-shims");
  return {
    HOPPER_REAL_PATH: realPath,
    PATH: `${shimDir}:${realPath}`,
  };
}

export function buildExecutePrompt(item: Item, planText: string): string {
  return buildPhasePrompt(
    "You are the EXECUTE phase of a multi-phase engineering workflow.",
    item,
    `1. Follow the plan above. Implement the changes in the current worktree.\n` +
      `2. ${GIT_OWNERSHIP_INSTRUCTION}\n` +
      `3. You may read git state (\`git diff\`, \`git log\`, \`git status\`) for context, but do not mutate it.\n` +
      `4. Stop when the code and tests are in place. The next phase (Validate) will run the plan's validation commands.\n` +
      `5. Provide a short summary of what you changed in your final message.\n`,
    planText,
  );
}

/**
 * Remove the original checkout path from a phase prompt when Hopper is running
 * in a worktree. Absolute paths beneath the checkout become worktree-relative,
 * so delegated agents receive the same unambiguous location as their parent.
 */
export function relativizeWorktreePrompt(prompt: string, workingDir: string): string {
  const checkout = workingDir.replace(/\/+$/, "");
  if (!checkout) return prompt;
  return prompt.split(checkout).join(".");
}

export function buildExecuteOptions(agent?: string, env?: Record<string, string>): SessionOptions {
  return {
    model: "balanced",
    effort: "medium",
    ...(agent ? { agent } : {}),
    disallowedTools: [...EXECUTE_DISALLOWED_TOOLS],
    ...(env ? { env } : {}),
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
  return buildPhasePrompt(
    `You are the EXECUTE phase of a multi-phase engineering workflow. ` +
      `This is remediation attempt ${attempt} — an earlier execute pass completed, ` +
      `but the validate phase that followed reported failures.`,
    item,
    `1. Focus on fixing ONLY the issues surfaced by the validate phase. Do not redo changes that already landed correctly.\n` +
      `2. ${GIT_OWNERSHIP_INSTRUCTION}\n` +
      `3. You may read git state (\`git diff\`, \`git log\`, \`git status\`) to see what's already in the worktree.\n` +
      `4. Stop when the fixes are in place. Validate will run again after you return.\n` +
      `5. Provide a short summary of what you changed in this attempt.\n`,
    planText,
    `## What the previous execute attempt reported\n\n${priorExecuteResult}\n\n` +
      `## Validate-phase failure output\n\n${priorValidateResult}\n\n`,
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
  return buildPhasePrompt(
    "You are the VALIDATE phase of a multi-phase engineering workflow.",
    item,
    `1. Run the validation commands listed in the plan (test suite, linter, type checker, any project-specific checks).\n` +
      `2. Inspect the diff with \`git diff\` / \`git log\` / \`git status\` / \`git show\` to judge whether the worktree now satisfies the plan.\n` +
      `3. ${GIT_OWNERSHIP_INSTRUCTION}\n` +
      `4. If validation fails, report which checks failed with their output. Only fix trivial issues (e.g. an unused import) yourself — anything larger is a signal to requeue.\n` +
      `5. End your final message with one of these exact tokens on its own line:\n` +
      `   - \`VALIDATE: PASS\` — all checks passed and the diff satisfies the plan.\n` +
      `   - \`VALIDATE: FAIL\` — something is wrong; include the failure details above.\n`,
    planText,
  );
}

export function buildValidateOptions(env?: Record<string, string>): SessionOptions {
  return {
    model: "deep",
    effort: "high",
    tools: [...VALIDATE_TOOLS],
    allowedTools: [...VALIDATE_ALLOWED_TOOLS],
    disallowedTools: [...EXECUTE_DISALLOWED_TOOLS],
    ...(env ? { env } : {}),
  };
}

/**
 * Decide whether the validate phase's final message indicates success.
 *
 * We look for the VALIDATE: PASS / FAIL token in the result. Ambiguous or
 * missing output is treated as a failure — we'd rather requeue than merge
 * something unverified.
 */
export interface ValidateOutcome {
  passed: boolean;
  reason: string;
}

export interface ValidateOutcomeWithFallback extends ValidateOutcome {
  fallbackUsed?: boolean;
}

export function resolveValidateOutcome(exitCode: number, resultText: string): ValidateOutcome {
  if (exitCode !== 0) {
    return { passed: false, reason: `Validate phase exited ${exitCode}` };
  }
  const passMatch = /^VALIDATE:\s*PASS\s*$/m.test(resultText);
  const failMatch = /^VALIDATE:\s*FAIL\s*$/m.test(resultText);
  if (passMatch && !failMatch) return { passed: true, reason: "validate reported PASS" };
  if (failMatch) return { passed: false, reason: "validate reported FAIL" };
  return { passed: false, reason: "validate phase did not emit a PASS/FAIL marker" };
}

export const MISSING_MARKER_REASON = "validate phase did not emit a PASS/FAIL marker";

/**
 * Build the prompt that asks the fast model to classify a validate-phase output as
 * PASS, FAIL, or UNCLEAR when the agent forgot to emit the required marker.
 */
export function buildValidateFallbackPrompt(resultText: string): string {
  return (
    `You are a validation assessor. An AI agent ran a validation phase and produced the text below, ` +
    `but forgot to end its message with the required VALIDATE: PASS or VALIDATE: FAIL marker.\n\n` +
    `Classify the agent's conclusion as one of:\n` +
    `- PASS  — the agent concluded that validation passed (e.g. "all checks pass", "tests are green", "all validation passes")\n` +
    `- FAIL  — the agent concluded that validation failed (e.g. "failed", "broken", "regression", "errors found")\n` +
    `- UNCLEAR — the text is ambiguous or does not clearly indicate either outcome\n\n` +
    `When in doubt, use UNCLEAR. Respond with ONLY one word: PASS, FAIL, or UNCLEAR — no other text.\n\n` +
    `Agent output:\n${resultText}\n`
  );
}

/**
 * Normalise a raw fallback-assessor response into one of the three recognised tokens.
 * Anything that cannot be mapped to PASS or FAIL is treated as UNCLEAR.
 */
export function normaliseValidateFallback(raw: string): "PASS" | "FAIL" | "UNCLEAR" {
  const token = raw.trim().toUpperCase();
  if (token === "PASS") return "PASS";
  if (token === "FAIL") return "FAIL";
  return "UNCLEAR";
}

// ---------------------------------------------------------------------------
// Fast-model one-shot helpers (branch slug + commit message)
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
 * Normalise a raw branch-slug response into a safe kebab-case slug.
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

export type BranchSlugSource = { type: "cached"; slug: string } | { type: "generate" };

/**
 * Decide whether the item already has a cached branch slug or needs one
 * generated. Using a cached slug on re-claims ensures the same work-branch
 * name regardless of LLM non-determinism.
 */
export function resolveBranchSlugSource(item: {
  engineeringBranchSlug?: string;
}): BranchSlugSource {
  if (item.engineeringBranchSlug) {
    return { type: "cached", slug: item.engineeringBranchSlug };
  }
  return { type: "generate" };
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
 * labels) from a generated commit message.
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
