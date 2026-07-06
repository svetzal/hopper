# Safe-by-default `integrate` / `cancel`

Status: **shipped 2026-07-06** — kept as the design record + dependency audit
behind the change. Captured alongside the commander migration (which resolved
audit findings #2, #3, #5, #6, #7); this note covered the remaining finding
**#1** from the CLI-UX audit, now implemented (`integrate` previews unless
`--apply`; `cancel` confirms / needs `--yes` before discarding unmerged work).

## The change

Two mutating commands currently destroy state by default, inverted from the
fleet's plan-then-`--apply` convention:

- **`integrate <id>`** merges the item's branch into `main` and force-deletes
  the branch **by default**; preview is opt-in via `--dry-run`
  (`src/commands/integrate.ts`).
- **`cancel <id>`** on an `in_progress` engineering item force-deletes an
  **unmerged** work branch and its worktree with no preview, no confirmation,
  and no `--yes` bypass (`src/commands/cancel.ts` → `teardownEngineeringWorktree`).
  This is the one genuine data-loss path: cancelling a parked engineering run
  discards its commits irreversibly.

Target behaviour:

- `integrate <id>` **previews by default**; executes only with `--apply`. The
  dry run already names the concrete git commands — keep that, and end it with
  "re-run with --apply to make these changes."
- `cancel <id>` **prompts before destructive teardown** (only when there is
  unmerged work at risk — a queued item has nothing to destroy and can stay
  prompt-free), with a `--yes` bypass for scripts and agents.

Both follow the shared vocabulary: `--apply` to execute a previewed mutation,
`--yes` to skip a confirmation, `--force` reserved for overriding a *refusal*.

## Dependency audit — what actually depends on the current behaviour

Searched all of `~/Work/Projects`, `~/Work/Operations`, `~/Library/LaunchAgents`,
and the foundry registry/config for callers of `hopper integrate` / `hopper cancel`.

- **No shell scripts, launchd agents, or foundry blocks invoke either command.**
  The only foundry hits are historical trace logs; the only Operations hits are
  session transcripts and the concluded `EXP-002` experiment (which documents
  *why* `integrate` exists — it absorbed the manual `git checkout main &&
  git merge hopper/<branch>` chain). Nothing runs these commands unattended, so
  **the flip breaks no background automation.**
- **hopper's own worker does not shell out to the CLI.** Task-item merge-back is
  done in-process (`worker-workflow.ts` / `git-workflow.ts`), not via
  `hopper integrate`. Flipping the CLI surface does not touch the worker path.
- **The one real dependent is the coordinator skill**
  (`skills/hopper-coordinator/SKILL.md`) — the agent-facing guidance embedded in
  the binary and installed via `hopper init`. It documents `hopper integrate <id>`
  and `hopper cancel <id>` as the way to *actually* merge/cancel. Under a
  safe-by-default flip, an agent following this guidance would preview-only and
  believe the action completed. This is a guidance dependency, not a code one.

## What must change alongside the code

### Code (`src/`)

- `commands/integrate.ts` — invert the default: preview unless `--apply`. Keep
  `--dry-run` accepted as a back-compat no-op (it already means "preview", which
  is now the default) so existing muscle memory and skill examples don't error.
- `commands/cancel.ts` — add a confirmation prompt on the destructive teardown
  branch (unmerged worktree/branch present), with a `--yes` bypass. Route the
  prompt through an injectable gateway so it stays testable and non-interactive
  when stdout is not a TTY (auto-fail closed without `--yes`).
- `cli.ts` — add `.option("--apply", …)` to `integrate` and `.option("--yes", …)`
  / keep `--dry-run` on the relevant commands; update the `[mutates]` summaries
  to `[mutates with --apply]` where appropriate.
- Tests — assert `integrate` performs no git mutation without `--apply`, and
  that `cancel` refuses the destructive path without `--yes` when non-interactive.

### Coordinator skill (`skills/hopper-coordinator/SKILL.md`)

- Rewrite the integrate examples (~lines 376–379) to the two-step form:
  `hopper integrate <id>` (preview) → `hopper integrate <id> --apply` (execute).
- Update the cancel guidance (~lines 356–357, 572, 738) to pass `--yes` for the
  non-interactive/agent destructive path.
- **Fix stale line 31** — it currently claims "`hopper cancel` refuses to operate
  on IN_PROGRESS items. There is no `--force` flag." That is already wrong: since
  3.3.0 `cancel` accepts in-progress items and tears down their worktree (see
  CHANGELOG). This line must be corrected regardless of finding #1, and the new
  `--yes` behaviour documented here.
- Re-embed + release: the skill is embedded at build time and propagated by
  `hopper init`; ship a release and re-run `hopper init` so the global skill
  matches the new behaviour.

### Docs

- CHANGELOG `[Unreleased]` — this is a **behaviour change** (integrate no longer
  merges without `--apply`); mark it clearly. It is not automation-breaking (see
  audit above), but interactive/agent muscle memory changes.
- Consider a short line in `migration-*.md` if it lands in a major bump.

## Why deferred

The commander migration was a pure parser swap with identical runtime behaviour.
This change alters what `integrate`/`cancel` *do*, so it needs its own commit,
its own release, and the coupled skill update above — it should not ride silently
inside a refactor.
