# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [4.1.2] - 2026-07-18

### Fixed

- OpenCode-backed sessions now recover their final assistant text from the
  JSONL stream when `opencode export` is unavailable or empty, preventing
  successful `VALIDATE: PASS` results from being misrecorded as failures and
  triggering unnecessary repair attempts.
- Engineering phase prompts now replace original-checkout paths with
  worktree-relative paths, and execute attempts fail clearly when the original
  checkout's git status changes, preserving misplaced edits for recovery.

## [4.1.1] - 2026-07-17

### Fixed

- Codex profiles now receive Hopper's per-phase reasoning effort through the
  Codex CLI configuration surface. Profile-bound effort still overrides the
  workflow default, and Hopper's `minimal` level maps to Codex `low`, matching
  the existing Claude translation.

## [4.1.0] - 2026-07-16

### Fixed

- **Engineering runs that end without integrable work no longer wedge their
  repo's queue.** An item whose plan phase failed, whose execute phase exited
  non-zero, or whose validate never passed within the retry budget used to be
  parked at `in_progress` forever; because the worker serializes claims per
  working directory, that zombie silently blocked every later queued item for
  the same repo (observed 2026-07-16 with item b77a91b1 / parite-cli). Those
  runs now transition to a new terminal `failed` status. The worktree and work
  branch are preserved exactly as before.

### Added

- **`failed` item status.** Terminal state for worker runs that ended without
  integrable work. Failed items appear in the default `hopper list` view with a
  `[failed at <phase>]` badge, carry `failedAt`/`failedBy` and the failure
  transcript in `result`, and are recoverable three ways: `requeue` (retry),
  `integrate` (salvage the preserved work branch), or `cancel` (discard, with
  worktree/branch teardown and the same confirm gate as in-progress cancels).
- **Orphaned-claim detection at worker startup.** `hopper claim` now records
  the claiming worker's OS pid on the item; when a worker starts, any
  `in_progress` item whose recorded pid is no longer alive is flagged with a
  warning (including the requeue/cancel commands to recover) instead of being
  silently held. Detection is flag-only — nothing is auto-requeued.

## [4.0.1] - 2026-07-14

### Changed

- **Hopper now enforces ownership of the complete git lifecycle across agent
  runners.** Default tasks and engineering execute/validate phases receive an
  explicit instruction to ignore embedded git-operation clauses, Claude gets a
  git-mutation denylist, and all POSIX runners get a git-only PATH shim. The
  coordinator skill now tells dispatchers to describe the work product and
  validation only, leaving sync, branch/worktree setup, commit, merge, push,
  and cleanup to Hopper.

## [4.0.0] - 2026-07-06

CLI-UX release: the command surface was migrated to `commander` and audited
against the [CLI-UX principles](https://github.com/svetzal/guidelines). See
[docs/migration-3.x-to-4.x.md](https://github.com/svetzal/hopper/blob/main/docs/migration-3.x-to-4.x.md)
for the upgrade guide.

### Changed

- **BREAKING: `hopper reprioritize <id> <level>` is renamed to
  `hopper edit <id> --priority <level>`.** `reprioritize` was a bespoke verb
  outside the shared fleet vocabulary (`add`/`list`/`show`/`edit`/`remove`/…);
  `edit` aligns it and leaves room to grow other editable fields. There is no
  back-compat alias — the old verb is gone. The coordinator skill and the
  investigation sandbox's queue-mutation denylist are updated to `edit`.
- **Error messages now suggest the fix.** The `add` validation errors that
  previously only restated the failure (`--branch requires --dir`,
  `--branch is required when --dir is set`, `--times requires --every`,
  `--until requires --every`) now append a runnable `Try: hopper add …` example,
  per the CLI-UX principle that an error should teach the next step.
- **BREAKING: `hopper integrate` is now safe-by-default — it previews unless
  `--apply` is given.** Previously `integrate <id>` merged the item's branch
  into `main` and force-deleted the branch immediately, with `--dry-run` as the
  opt-in preview. Now `integrate <id>` prints the exact git commands and makes
  **no changes**; pass `--apply` to execute (this is the standard plan-then-apply
  convention across the tool fleet). `--dry-run` is retained as an accepted
  no-op alias for the default preview, so existing muscle memory keeps working.
  Nothing in `~/Work/Projects` scripts `integrate`, so no automation breaks; the
  coordinator skill guidance is updated to the two-step form.
- **`hopper cancel` now confirms before discarding unmerged work.** Cancelling
  an in-progress *engineering* item force-deletes its unmerged work branch and
  worktree (commits are lost). `cancel` now prompts for confirmation before that
  teardown and requires `--yes` when run non-interactively (agents/workers/CI) —
  without it the cancel aborts and the item is left untouched. Cancelling a
  queued/scheduled/blocked item destroys nothing and is unaffected (no prompt).
  Also corrects long-standing coordinator-skill drift that claimed `cancel`
  refuses in-progress items.
- **Migrated CLI argument parsing from the hand-rolled parser to `commander`.**
  The bespoke `parseArgs` in `cli.ts` is replaced by a `commander` command tree
  (`buildProgram`), with a thin adapter (`commander-adapter.ts`) converting
  commander's output into the internal `ParsedArgs` shape so all command bodies
  and their tests are unchanged. This aligns hopper with the sibling TypeScript
  CLI (`mailctl`, also commander) as identified in a CLI-UX audit. User-visible
  improvements:
  - **Per-command help** — `hopper <command> --help` now shows help specific to
    that command instead of the whole global usage wall.
  - **Unknown flags are rejected** — a mistyped or unsupported flag now errors
    with exit code 1 instead of being silently ignored.
  - **Unknown commands suggest a near match** — e.g. `integrte` → "Did you mean
    integrate?".
  - **Mutating commands are marked `[mutates]`** in help, making the read/write
    boundary visible before anything runs.
  - `preset` and `profiles` are now consistent subcommand trees with their own
    per-subcommand help.

  All existing flags, aliases (`-p`, `--depends-on`), repeatable options, exit
  codes, stderr routing, and `--json` output are preserved.

## [3.6.0] - 2026-07-06

### Changed

- **`hopper init` migrated to `cmx-core` plan/apply/status/remove.** The
  hand-rolled installer has been replaced with the `cmx-core` abstraction,
  preserving Hopper's JSON contract and deprecated-directory cleanup. Tests
  and docs updated for global-default installs.

## [3.5.1] - 2026-07-05

### Documentation

- **Documented that read-only `aws` is allowed in the investigation sandbox.**
  `AGENTS.md` and the coordinator skill (`skills/hopper-coordinator/SKILL.md`)
  previously described the sandbox as blocking all network-egress CLIs and told
  brief authors to inline load-bearing evidence. They now record that, since
  3.4.0, read-only `aws` (`get-*`/`describe-*`/`list-*`/`query`/`scan`/
  `batch-get-item`) is permitted while mutations stay denied — so an
  investigation hinging on live AWS/DynamoDB state can query it directly rather
  than requiring that state be inlined.

## [3.5.0] - 2026-07-05

### Changed

- **`hopper cancel` now accepts in-progress items and tears down their
  worktree.** hopper deliberately parks a failed engineering run at
  `in_progress` (worktree + branch preserved) "until a human requeues or
  cancels" — see `inferEngineeringPhase` — but `cancel` previously refused any
  in-progress item, contradicting that documented contract and leaving no way
  to abandon a stuck run short of requeuing it first. Cancelling an in-progress
  engineering item now also removes its `~/.hopper/worktrees/<id>` worktree and
  force-deletes the abandoned `hopper-eng/<slug>-<prefix>` work branch
  (best-effort — teardown failures surface as warnings, the cancel still
  succeeds). Queued/scheduled/blocked cancels are unchanged; completed and
  cancelled items are still rejected.

## [3.4.0] - 2026-07-05

### Changed

- **Investigation sandbox now allows read-only AWS calls instead of denying
  `aws` outright.** The `aws` PATH-shim is verb-aware (like the `git` shim):
  it scans past leading global flags to find the service and action, then
  allows only clearly read-only actions (`get-*`, `describe-*`, `list-*`,
  `query`, `scan`, `batch-get-item`, plus bare `aws`/`--version`/`help`) and
  denies everything else by default — so mutating calls (`put-item`,
  `update-item`, `delete-item`, `batch-write-item`, `s3 cp`, ...) and any
  unrecognised action stay blocked at the binary level for all runners
  (claude, codex, opencode). `aws` is removed from `FULL_DENY_BINARIES` and
  from the Claude `disallowedTools` list; the PATH-shim
  (`buildAwsReadonlyShimScript` / `AWS_READONLY`) is the single source of
  truth for the read/write distinction, re-injected via
  `buildInvestigationShimMap`. Unblocks investigations that need to verify
  live production state (e.g. `aws dynamodb get-item`,
  `aws sts get-caller-identity`).

## [3.3.2] - 2026-07-03

### Fixed

- **`hopper integrate` no longer reports success when the underlying git merge
  was a no-op.** Engineering items now merge the real work branch
  (`hopper-eng/<slug>-<prefix>`) into the target branch instead of
  target-into-target. HEAD SHA is captured before and after the merge; if it
  did not advance, the command returns an error and skips cleanup so a no-op
  can never masquerade as a successful integration.

### Changed

- **Coordinator skill: removed the hone maintenance/iteration section** from
  the skill file to keep the coordinator prompt focused.

## [3.3.1] - 2026-06-26

### Fixed

- **Terminal Claude account-limit failures now complete visibly instead of
  requeueing or lingering ambiguously.** Hopper classifies Claude `result`
  records with `api_error_status=429` and spend/quota/account-limit wording as
  terminal `account_limit` failures. Generic and engineering workers complete
  the item with an operator-facing summary instead of retrying the same failing
  provider profile, and `hopper audit` exposes the provider/status/kind/message
  signal in JSON summaries and decoded tails.

### Changed

- **Docs/comments: dropped the "2026-06-15 Anthropic cutoff" framing.** A
  predicted cutoff of third-party tools on Anthropic subscription plans did
  not materialize. The `claude` runner works on a subscription as before. The
  `openai` bootstrap default is retained purely as a clean-install
  convenience, not because the `anthropic` profile is unavailable. Profile
  docs and source comments now describe `openai` as a default you can freely
  switch away from, rather than a forced choice.
- **Documented OAuth-token expiry.** Added an auth note to `docs/profiles.md`
  and the profiles gateway: the `claude` and `codex` runners use OAuth tokens
  that expire, and a `401 Invalid authentication credentials` at the plan/exec
  phase means a local re-login is needed (then `hopper requeue <id>`) — it is
  not a service or policy change.

## [3.3.0] - 2026-05-31

### Added

- **Codex runner support.** Profiles can now use `"runner": "codex"` to
  dispatch work through `codex exec --json`. Hopper streams Codex JSONL events
  to the audit file and captures the canonical final assistant message via
  `--output-last-message`.
- **Shipped `codex` profile.** Fresh installs and upgraded profile directories
  now get a `codex` template that maps `deep`, `balanced`, and `fast` to bare
  Codex model names (`gpt-5.5`, `gpt-5.4`, `gpt-5.4-mini`) and includes a
  `gpt-5.3-codex` alias.

### Changed

- Profile bootstrap now fills in newly shipped profile files without
  overwriting existing user profiles, so existing installations receive new
  templates like `codex.json`.
- Codex-backed sessions support Hopper craftsperson selection by prepending the
  selected `~/.claude/agents/<name>.md` body to the prompt, since Codex CLI has
  no native `--agent` equivalent.

## [3.2.0] - 2026-05-23

### Added

- **Read-only Bash sandbox for investigation items.** Investigation sessions
  now include the `Bash` tool with `INVESTIGATION_DISALLOWED_TOOLS` denylist,
  enabling CLI-based evidence queries (`hopper show|list|audit|history`,
  `git log|status|diff|show|rev-parse|blame|for-each-ref`, `jq`, `cat|ls|head|
  tail|wc|find|grep|rg|awk|sed`, `foundry history|trace`, `evt query|aggregate`)
  while blocking all mutating operations (git writes, queue mutations, package
  installs, network-egress CLIs, destructive filesystem verbs). `permissionMode:
  "plan"` is no longer applied — the denylist is the control surface.

### Internal

- Extracted `resolveEffectiveExitCode`, `buildSessionPreamble`, and
  `resolveOpencodeEnv` from gateway implementations into their respective
  pure-function modules (`extract-opencode-result.ts`, `extract-result.ts`,
  `opencode-config-content.ts`). Gateways now perform only I/O; all domain
  decisions live in the pure layer.
- Extracted `buildRecurredItem` from `complete` in `store-workflow.ts`,
  `runExecuteAttempt`/`runValidateAttempt` from `runExecuteValidateLoop` in
  `worker-engineering.ts`, and `setupGenericWorktree` from `processItem` in
  `worker.ts` for single-responsibility clarity.
- Deepened test coverage for `worker-loop`, `worker-engineering`, and
  `worker-shared` orchestration paths.

### Maintenance

- Bumped `@types/node` to `^25.9.1`.

## [3.1.1] - 2026-05-18

### Fixed

- **`hopper show` no longer drops the execute-phase cost for opencode-runner
  items when the terminal `opencode-export` event is missing.** Discovered
  during the 5-profile Space Invaders bake-off: `opencode export` post-session
  can return nothing on long runs, in which case the opencode gateway never
  appends its synthetic terminal record, so `extractPhaseCost` returned `null`
  and the phase silently dropped from `cost.phases`. The per-step
  `step_finish` records still contain full `cost`/`tokens` fields, so
  `extractPhaseCost` now falls back to summing them when no terminal event is
  present. Effect on the bake-off case: the glm execute phase that previously
  reported `$0.00` now reports `$2.20`, matching the audit-log ground truth.
  Healthy runs (terminal event present) are unaffected — the terminal record
  still wins. Claude-runner items are unaffected (they never emit
  `step_finish`).

## [3.1.0] - 2026-05-18

A small follow-up to 3.0 picking up profile ergonomics and `hopper list`
clarity after exercising the new profile system end-to-end.

### Added

- **Per-tier effort overrides in profiles.** Profile model entries now
  accept either the shorthand string form or an object
  `{ "model": "...", "effort": "..." }` that pins reasoning effort for
  that tier, overriding the per-phase workflow default (plan/validate
  =high, execute=medium). Effort vocab: `minimal | low | medium | high
  | max` (claude maps `minimal` → `low`; opencode forwards verbatim).
  `hopper profiles` annotates overridden tiers with `(effort: <value>)`,
  and `hopper profiles show <name>` now emits the raw file content so
  shorthand stays shorthand. Shipped templates remain shorthand-only —
  no behavioural change for existing profiles.
- **Current phase in `hopper list`.** In-progress engineering items now
  show `[in progress: plan]`, `[in progress: execute]`,
  `[in progress: validate]`, or `[in progress: execute (retry N)]`
  instead of an opaque `[in progress]`. Derived from existing `phases`
  records — no schema change.

### Fixed

- **Openrouter profile model IDs.** The shipped openrouter template
  had two model IDs opencode rejected at dispatch, leaving items stuck
  in_progress: `claude-sonnet-4-6` → `claude-sonnet-4.6`, and
  `gemini-2-flash` → `gemini-2.5-flash`.
- **Failed-phase rendering in `hopper list`.** When execute exits
  non-zero or validate fails past the retry budget the worker preserves
  the worktree and bails — the item is stuck, not progressing. The
  phase-status badge no longer pretends the next phase started; failed
  items render as `[failed at <phase>]`.

### Changed

- **Default worker agent renamed `claude-worker` → `worker`.** The
  worker has been runner-agnostic since 3.0 (each item dispatches via
  its own profile); the old name showed up in `hopper list` as
  misleading attribution on items running against opencode / OpenAI /
  ollama / etc.

## [3.0.0] - 2026-05-18

This is a **major release** that introduces a profile system for per-job
runner + model selection, alongside the new opencode runner (alternative to
Claude Code), a vendor-agnostic tier vocabulary, and per-phase reasoning-effort
control.

> **Note on re-issue.** A 3.0.0 tag was briefly cut on 2026-05-18 that included
> opencode support but used a global `--runner` flag and a single
> `~/.hopper/runner-config.json`. That tag was deleted and replaced before
> reaching real-world use; the version shipped to users is the profile-system
> 3.0.0 documented here.

Upgrading from 2.x? See [docs/migration-2.x-to-3.x.md](docs/migration-2.x-to-3.x.md).
The TL;DR: on first use, hopper bootstraps `~/.hopper/config.json` +
`~/.hopper/profiles/{anthropic,openai,openrouter,ollama}.json`. New items are
queued against `defaultProfile: openai` unless `--profile <name>` overrides.
If you never set up an opencode runner pre-3.0, the upgrade is a no-op.

### Added

- **Per-job profiles.** Each engineering/investigation/task item is queued
  against a named profile (`hopper add --profile <name>`) that bundles a
  runner choice (`claude` | `opencode`) and a model-tier mapping. Profiles
  live as individual files at `~/.hopper/profiles/<name>.json`; the worker
  reads `item.profile` to decide which runner dispatches the call and how
  `deep`/`balanced`/`fast` resolve. See [docs/profiles.md](docs/profiles.md)
  for the design and the four shipped templates.
- **Profile bootstrap.** On first `hopper add` or `hopper worker`, hopper
  creates `~/.hopper/config.json` with `defaultProfile: "openai"` plus
  shipped templates for `anthropic`, `openai`, `openrouter`, and `ollama`.
  Existing files are never overwritten. The OpenAI default reflects
  Anthropic's 2026-06-15 policy blocking third-party tools from running on
  Anthropic subscription plans — direct API-key Anthropic users opt in via
  `--profile anthropic`.
- **`hopper profiles` commands.** `hopper profiles` lists every installed
  profile (the default flagged with `*`) along with each profile's runner
  and tier mapping. `hopper profiles show <name>` prints a profile's file
  contents.
- **Routing runner.** `src/gateways/routing-runner.ts` dispatches each
  `runSession`/`generateText` call to the right underlying runner based on
  the profile carried in `SessionOptions`. The worker holds a single
  `AgentRunner` — runner selection is internal to the profile system.
- **Native opencode `generateText`.** The opencode runner now implements
  `generateText` directly (spawning `opencode run` with a temporary audit
  file and reading the result via `opencode export`). Pre-3.0 opencode
  runs delegated one-shots to Claude Code; profile-driven dispatch needs
  each runner to stand alone.
- **opencode runner** (originally introduced in the briefly-cut 3.0.0).
  Session work routes through the [opencode](https://opencode.ai) CLI when
  the item's profile selects `runner: "opencode"`. Tool-allowlist fields
  are silently ignored (no equivalent on opencode); craftsperson agents
  inline via `OPENCODE_CONFIG_CONTENT` synthesised from
  `~/.claude/agents/<name>.md` bodies; outcome decided on exit code AND
  no error events in the stream. See `docs/opencode-spike.md` for the
  empirical CLI findings.
- **Vendor-agnostic model tier vocabulary.** Hopper addresses models
  through three tiers — `deep`, `balanced`, `fast` — in
  `src/profile.ts`. Each profile maps the tiers to runner-native model
  identifiers in its `models` block. Additional alias keys (e.g.
  `qwen-bf16`, `gpt-oss-large`) are allowed and resolvable the same way.
  Worker log lines name the tier so output is honest regardless of which
  runner is active.
- **Per-phase reasoning effort.** `SessionOptions.effort` field with
  unified vocabulary `minimal | low | medium | high | max`. Claude
  forwards as `--effort <value>` (mapping `minimal` → `low`); opencode
  forwards as `--variant <value>`. Per-phase defaults: plan / validate /
  investigation = `high`, execute = `medium`. Runner-native strings (e.g.
  claude's `xhigh`) forward verbatim.
- **Per-phase cost & token reporting in `hopper show`.** Engineering items
  display a `Cost & tokens` block summarising each phase's spend pulled
  from data already captured in audit JSONL files. Subscription/OAuth
  runs report `$0` honestly. Mixed-runner items (claude plan, opencode
  execute) render side by side with the model label per row.
- **Audit viewer support for opencode events.** `hopper audit <id> --tail`
  decodes opencode's `step_start`, `text`, `step_finish`, and synthetic
  `opencode-export` events alongside claude's stream-json. The render
  path is runner-agnostic.
- **Opt-in integration test for the opencode runner.**
  `src/gateways/opencode-gateway.integration.test.ts`, runnable via
  `HOPPER_OPENCODE_IT=1 bun test …`.

### Changed

- **BREAKING: `--runner` flag removed.** Runner selection is no longer
  worker-wide; it follows the item's profile. `hopper worker --runner X`
  now fails with a clean error pointing at `--profile`. Workers are
  runner-agnostic by default and dispatch per item.
- **BREAKING: `~/.hopper/runner-config.json` removed.** Profile files at
  `~/.hopper/profiles/<name>.json` replace it. The bootstrap procedure
  creates equivalent profile templates on first use; nobody had a
  hand-tuned `runner-config.json` against the briefly-cut prior 3.0.0
  (delete it if you did).
- **BREAKING: `SessionOptions.profile` required at the gateway layer.**
  Every `runSession` and `generateText` call must carry the profile so
  alias resolution works. The routing runner enforces this at dispatch
  time. Existing test fixtures need a profile field; production callers
  (the worker, the agent resolver) load profiles before invoking the
  runner.
- **`Item.profile` field** baked at `hopper add` time. Items added before
  the profile rollout fall back to `defaultProfile` from `config.json` at
  claim time.
- **Worker log lines** use tier names (`deep` / `balanced` / `fast`) rather
  than vendor aliases.

### Fixed

- **Empty-diff commit messages for fresh-from-scratch projects.** When the
  execute phase generated an entire project with every file untracked,
  `git diff HEAD` (used by `diffSummary`) excluded them, so the
  commit-message model received an empty diff and frequently responded
  with a meta-complaint that became the commit message verbatim. Added
  `GitGateway.stageAll` and call it before `diffSummary` in
  `commitEngineeringChanges`; `commitAll` still re-stages internally so
  the change is safely idempotent.

### Internal

- New pure module `src/profile.ts`: profile shape, validation, name
  vocabulary, and tier-resolution helper.
- New gateway `src/gateways/profiles-gateway.ts`: per-file I/O over
  `~/.hopper/profiles/`, plus bootstrap of shipped templates and
  `config.json`.
- New `src/gateways/routing-runner.ts`: profile-driven dispatch between
  the claude and opencode runners.
- Refactored the worker layer to accept typed context objects rather than
  long positional parameter lists (`ExecuteValidateContext`, etc.) and
  thread `profile: Profile` through all phase calls.
- Shared `streamToAuditFile` extracted to `src/gateways/audit-stream.ts`
  and used by both runners.
- Extracted pure helpers: `extract-opencode-result.ts`,
  `craftsperson-body.ts`, `opencode-argv.ts`,
  `opencode-config-content.ts`, `extract-cost.ts`.
- Deleted: `src/gateways/runner-config.ts`, `src/gateways/model-tier.ts`
  (`ModelTier` type moved into `src/profile.ts`).

## [2.1.4] - 2026-05-15

### Changed

- **Refactored `src/store.ts`** as part of an automated maintenance pass.
  Code organization improvements, no behavior change.

### Maintenance

- Bumped `@types/node` to `^25.8.0`.
- Removed a stale subagent worktree gitlink (`agent-a89694f2`) whose branch
  was already fully merged into main pre-v2.1.3.

## [2.1.3] - 2026-05-14

### Added

- **Haiku fallback assessor for missing VALIDATE markers.** When the validate agent's final message lacks a `VALIDATE: PASS/FAIL` marker, Hopper now routes through a Haiku-based assessment before failing closed. Haiku evaluates the final text for signals like "all checks pass" or "failed" and responds with PASS/FAIL/UNCLEAR; genuinely ambiguous results safely default to FAIL. Fallback invocation and decision are logged for observability.

### Fixed

- **`hopper integrate` now correctly detects worktree directories.** `Bun.file().exists()` is designed for files only and returns false for directories, causing in-progress items to be rejected even when their worktrees exist. Replaced with `node:fs/promises.stat()`. Error messages now distinguish between status-based and worktree-missing failures.
- **Validate marker detection in multi-session audit logs.** `extractResult` now returns the last result event instead of the first. This handles cases where long-running commands trigger a `task_notification` resume, creating multiple init/result pairs in the audit log and previously masking the final outcome.

## [2.1.2] - 2026-05-14

### Changed

- **Refactored command error handling to throw-based `unwrap` / `catchCommandError` pattern.** Eliminates ~24 two-line unwrap/guard blocks and 11 `requirePositional` guards across all command files. Command bodies are now straight-line code with no manual early returns for Result failures.
- **Extracted `logCompleteOutcome` and `logClaimBanner` into `worker-shared`.** Removes verbatim duplicate blocks that existed in both `worker.ts` and `worker-engineering.ts`.
- **Coordinator skill: clarified no-abort semantics for claims.** Added a "Claims are irrevocable" callout under the lifecycle diagram; rewrote the Cancelling and Requeuing sections to self-disclose the limitation. Fixes a misreading where `cancel`/`requeue` appeared to stop an in-flight worker session.

### Maintenance

- Dependency updates (@types/bun, @types/node, @biomejs/biome).

## [2.1.1] - 2026-05-09

### Documentation

- **hopper-coordinator skill: new "Dependency chains across tool calls" subsection covering shell-variable scope, post-add verification, claim race window, and recovery limits.**

## [2.1.0] - 2026-04-25

### Added

- **`hopper audit <id>` command — primary CLI surface for inspecting in-progress and completed work.** Replaces the previous practice of poking `~/.hopper/audit/*.jsonl` and `~/.hopper/items.json` directly. Default mode returns a summary (`totalEvents`, `perPhaseEvents`, `lastEventAt`, `lastEventGapSeconds`, top-5 `toolHistogram`, `lastCommands`, `lastIncompleteToolUse`); `--tail <n>` returns the last N decoded session events; `--plan` and `--result` return the engineering plan and result markdown; `--phase <name>` restricts summary/tail to a single engineering phase. Both `--json` and human output formats are supported.

### Changed

- **Coordinator skill principle: all hopper state is read through the hopper CLI.** New "Read State in JSON, Always" section establishes the rule and forbids direct inspection of `~/.hopper/audit/*` and `~/.hopper/items.json`. The "Investigating In-Progress Tasks" section is rewritten to use `hopper audit <id> --json` patterns instead of `wc`/`grep`/`jq`/Python against raw JSONL. The on-disk file-paths table is removed in favour of CLI-only diagnostics.
- **Coordinator skill steers the agent toward `--json` for all state reads.** Listing, viewing, monitoring, and dependency-chain example blocks now lead with `hopper list --json | jq …` and `hopper show <id> --json` patterns. The dependency-chain example captures a newly added item's id via `--json | jq -r '.id'` instead of implying the agent parses prose output.
- **List output for completed items now surfaces both *when* and *how long*.** `itemTiming` renders completed items as `(completed 2h ago, took 1h)` instead of the previous `(completed in 1h)`, which dropped the timestamp. Readers of `hopper list --completed` can now tell at a glance whether something finished recently or last week without dropping into `hopper show` or `--json`.

### Fixed

- **Engineering worker reuses safe preserved worktrees on requeue.** When an engineering execute fails, the worktree is preserved for inspection. On user requeue, if the worktree is clean with no commits ahead of target, the worker now reuses it instead of rejecting with a stale-branch error. Prevents infinite auto-requeue loops.

### Maintenance

- Consolidated test helpers across `src/commands/*.test.ts` (`test-helpers.ts`), reducing boilerplate across integrate / worker / worker-engineering / worker-shared test suites.
- Refactored `worker-engineering`, `add-agent-resolver`, `add`, `worker-loop`, and `titler` for clarity.
- Added `.worktrees` to `.gitignore`.
- Dependency updates.

## [2.0.7] - 2026-04-19

### Fixed

- **Flaky relative-time tests resolved by injecting clock.** `relativeTime` and `relativeTimeFuture` now accept an optional `nowMs` parameter so tests can pin the reference clock, eliminating intermittent failures caused by drift between two `Date.now()` calls under system load.
- **Engineering worker branch consistency and claim safety.** Cached the engineering branch slug to prevent non-deterministic collisions, made worktree setup tolerant of orphaned branches, and guaranteed requeue on pre-spawn failures before the Claude session starts.

## [2.0.6] - 2026-04-19

### Added

- **`hopper integrate <id>` command.** Automates the manual `cd <repo> && git checkout main && git merge hopper/<branch> --no-edit` cycle that previously had to be done by hand after each completed item. Resolves items by prefix, validates status (`completed` or `in_progress` with a worktree on disk), runs the merge, then removes the worker branch and hopper worktree by default. Flags: `--dry-run` (print commands, no execution), `--keep-worktree` (skip cleanup), `--json`.
- **Monitor-tool guidance in the coordinator skill.** New callout in "Investigating In-Progress Tasks" explains that the `Monitor` tool streams each stdout line as a notification and is preferable to repeated `pgrep -f X` + `tail /tmp/<log>` polling when watching a long-running background process.

## [2.0.5] - 2026-04-12

### Changed

- **Coordinator skill warns about non-idempotent `hopper add`.** Added a callout in the "Adding Work Items" section explaining that every successful `hopper add` mutates the queue immediately and re-running produces duplicates — check `hopper list` before retrying a batch that appeared to fail.
- **Coordinator skill adds batch verification pattern.** New "Batch Operations" subsection under Workflow recommends tagging batch adds with a unique tag and verifying the count via `hopper list --tag <tag> --json | jq 'length'` before proceeding.

## [2.0.4] - 2026-04-12

### Fixed

- **Recurring items silently lost v2.0.0 configuration on each cycle.** When a recurring item completed, the recurrence builder in `store-workflow.complete()` propagated only `priority`, `workingDir`, `branch`, `command`, and `tags` to the next-cycle item. `type`, `agent`, and `retries` — all added in v2.0.0 — were dropped, so an item created with `--type engineering --agent typescript-craftsperson --retries 3 --every 1d` would recur as a default `task` with no pinned agent and no custom retry count. The recurrence builder now propagates all three fields.

## [2.0.3] - 2026-04-12

### Fixed

- **Worker pegged CPU at ~100% when active tasks existed but no new work was queueable.** `resolvePostClaimLoopAction` returned `{ type: "continue" }` whenever there were active tasks — even if `claimNext` returned nothing new — so the outer loop immediately re-entered `claimNext` (re-reading `~/.hopper/items.json` every iteration). With at least one long-running task in flight, this was an unbounded busy-loop eating a full CPU core until something settled. The post-claim action now returns `sleep` whenever nothing was newly claimed, matching the fully-idle path. Latency to pick up newly-eligible work is bounded by the `--interval` setting, which was already the case for idle polling.

## [2.0.2] - 2026-04-12

### Added

- **Auto-requeue on Claude startup failures.** When Claude exits non-zero without producing any captured `result`-type event (typical signature of an argv / environment / startup error), the worker now calls `requeueItem` with a descriptive reason so the queue self-heals instead of leaving the item wedged at `in_progress`. Items that did produce a real result still stay in-progress on purpose — the operator probably wants to read the partial output before deciding whether to retry. Pure decision lives in `resolveAutoRequeue(exitCode, extractedResult)`.

### Changed

- **Stderr captured from Claude is now wrapped as a JSONL event.** Previously the claude subprocess's stderr was appended raw to the audit file, which tacked a non-JSON line onto the tail and broke line-by-line parsers. Stderr now lands as a single `{"type":"stderr","text":"…"}` JSONL row (multi-line stderr stays in one event, with newlines escaped). Empty stderr emits nothing.

## [2.0.1] - 2026-04-12

### Fixed

- **Investigation items and every engineering phase that set multiple tools were dying at session startup.** `buildClaudeArgv` spread `--tools`, `--allowedTools`, and `--disallowedTools` as variadic argv tokens, which claude CLI's Commander-style variadic parser greedily consumed — swallowing the prompt along with the tool names. The subprocess then exited with `Error: Input must be provided either through stdin or as a prompt argument when using --print`, leaving the item wedged at `in_progress`. Tool arrays are now joined into a single comma-separated token (matching claude's `--help` example `"Bash,Edit,Read"`), and the prompt is emitted after a `--` option-parsing terminator so it can never be siphoned into an option's value list. The same fix was applied to `ClaudeGateway.generateText` (the Haiku one-shot helper).

## [2.0.0] - 2026-04-12

### Added

- **Task types.** `hopper add --type <task|engineering|investigation>` picks a workflow per item. `task` (default) preserves existing behaviour exactly; `engineering` runs a phased plan→execute→validate flow; `investigation` runs a read-only session whose final markdown message becomes the item's result
- **Investigation workflow.** Read-only, no worktree, no branch. Uses Opus with plan-mode permissions and a locked-down tool allowlist (Read, Grep, Glob, WebFetch, WebSearch, Task). Deliverable is a markdown findings report stored verbatim in `item.result`
- **Engineering workflow.** Multi-phase orchestration where each phase gets its own model and tool profile: plan (Opus, plan mode, read-only tools), execute (Sonnet, craftsperson agent, git mutations denied), validate (Opus, read-only git plus test/lint tools). Hopper owns every git operation — the agent never commits, branches, merges, or pushes
- **Craftsperson auto-resolution.** For engineering items without `--agent`, Hopper probes the project for stack markers (`package.json`, `Cargo.toml`, `pyproject.toml`, etc.) and asks Haiku to pick the best-fitting agent from `~/.claude/agents/` and `<project>/.claude/agents/`. Resolved name is stored on the item and visible in `hopper show`
- **Haiku as a text utility.** New `ClaudeGateway.generateText` helper (no tools, no permissions) generates branch slugs and Conventional Commit messages. Engineering branches use `hopper-eng/<slug>-<id-prefix>` with deterministic fallback when the Haiku call fails
- **Remediation retry loop.** When validate reports `VALIDATE: FAIL`, Hopper loops back into execute with the prior execute summary and validate failure inlined, up to `--retries <n>` times (default 1, max 5; `0` disables). Each retry writes its own audit files (`<id>-execute-2.jsonl`, `<id>-validate-2.jsonl`, …)
- **Per-phase visibility.** `PhaseRecord[]` on each engineering item records `{ name, attempt, startedAt, endedAt, exitCode, passed? }` as each phase finishes. `hopper show` renders a status strip like `plan ✓ 34s / execute ✓ 2m11s / validate ✗ FAIL / execute ✓ 45s / validate ✓ 20s`
- **Per-phase audit artefacts.** Engineering items write `<id>-plan.jsonl`, `<id>-execute.jsonl`, `<id>-validate.jsonl` (plus `-N` suffixes for retries) under `~/.hopper/audit/`. The plan's markdown text is persisted to `<id>-plan.md` — never inside the worktree, so nothing leaks into the committed diff
- `hopper add --agent <name>` and `hopper preset add --agent <name>` to force a specific craftsperson
- `hopper add --retries <n>` and `hopper preset add --retries <n>`
- `hopper list --type <type>` filter, plus `[eng]` / `[inv]` badges in the default list output
- Coordinator skill gained a "Choosing a task type" section, engineering/investigation examples, and documentation for retries and auto-resolution
- Coordinator skill now includes 'Investigating In-Progress Tasks' section with audit log diagnosis, process inspection, failure mode taxonomy, and decision flow for stuck tasks

### Changed

- `Item` gained optional `type`, `agent`, `phases`, and `retries` fields. All optional — existing `~/.hopper/items.json` files load without migration. Legacy items (no `type`) follow the original single-session workflow unchanged
- Coordinator skill now includes guidance on naming craftsperson subagents in work item descriptions for stack-specific engineering standards
- Revise failure-mode guidance: remove speculative frequency-ranked table, replace with signal-based bullet list

### Notes

- Major version bump reflects the scope of new first-class concepts (task types, phased workflows, per-item agent resolution, remediation loops) rather than a backwards-incompatible break. Existing queues, presets, CLI invocations, and worker scripts continue to work unchanged

## [1.5.2] - 2026-04-11

### Fixed

- Git tags created by workers in worktrees are now pushed to the remote after merge

### Changed

- Standardized release process documentation in AGENTS.md

## [1.5.1] - 2026-04-11

### Fixed

- Fix git spawn ENOENT error in worker when invoking git subprocesses

## [1.5.0] - 2026-04-11

### Added

- Directory-aware parallel claiming — `claimNext` automatically serializes items that target the same or overlapping `workingDir`, including parent/child containment detection (e.g., `/repo` and `/repo/subproject` serialize, but `/repo/a` and `/repo/b` run in parallel)
- Items without an explicit `workingDir` use the process CWD as their effective directory for serialization

### Changed

- Default worker concurrency bumped from 1 to 4 — safe because same-directory work is now automatically serialized
- Coordinator skill no longer requires manual `--after-item` chaining for conflict prevention; `--after-item` is now only needed for logical dependencies or explicit ordering

## [1.4.0] - 2026-03-28

### Changed

- Worker task prompt now instructs agents to follow analyze → plan → execute → validate phases, requiring tests and linter to pass before declaring work done
- Coordinator skill adds validation criteria guidance, recommended description structure (Context / Work / Validation), and updated examples that consistently include validation requirements

## [1.3.0] - 2026-03-25

### Fixed

- Automatic merge-back now works for newly created target branches — previously skipped with "target branch not checked out" when the branch didn't exist before the worker created it

### Changed

- Extracted git workflow decisions (branch setup, merge steps) to pure functions in `git-workflow.ts`
- Extracted add command logic to functional core in `add-workflow.ts`

### Maintenance

- Upgraded TypeScript to 6.0.2
- Updated @types/bun to 1.3.11
- Added local installation instructions to AGENTS.md

## [1.2.1] - 2026-03-17

### Added

- Version guard on `hopper init` — refuses to overwrite a newer skill with an older binary unless `--force` is used
- `--force` flag for `hopper init` to bypass version guard
- Skill Distribution section in AGENTS.md documenting the init workflow

## [1.2.0] - 2026-03-17

### Added

- `--times <n>` flag for `add` command to limit the number of recurrences when used with `--every`
- Worker auto-pushes to origin after successful merge of work branch

## [1.1.0] - 2026-03-17

### Added

- Arbitrary shell command support via `--command` flag on `add` and `preset add` — worker runs the command via `sh -c` instead of spawning Claude
- Shell gateway (`src/gateways/shell-gateway.ts`) for command execution with stdout/stderr capture and audit logging
- `--dir` without `--branch` is now valid when `--command` is set (runs command in that directory without worktree)
- `command` field displayed in `show`, `preset show`, and `preset list` output

## [1.0.2] - 2026-03-07

### Changed

- Document release process in AGENTS.md

## [1.0.1] - 2026-03-07

### Fixed

- Worker now exits immediately on Ctrl-C when idle (poll sleep is cancelled on shutdown)

## [1.0.0] - 2026-03-07

### Added

- Recurring items with `--every` flag (e.g. `--every 2h`, `--every 1d`) — completed items automatically re-queue on schedule
- Scheduling and duration parsing support for recurring intervals
- Concurrent worker support with `--concurrency` flag to process multiple items in parallel
- Preset/template commands (`preset add`, `preset list`, `preset use`) for reusable work items
- Item priorities with `--priority` flag (`low`, `medium`, `high`, `critical`) and priority-based queue sorting
- Item dependencies with `--after-item` flag — dependent items show `blocked` status until their prerequisite completes
- Tagging system with `--tag` flag on `add` and `--tag` filter on `list`
- `--global` flag on `init` to install skills to `~/.claude/skills/` for system-wide availability

### Changed

- Worker now commits on Claude's behalf using the item title and Claude's summary as the commit message, instead of running a separate auto-commit Claude session
- Task prompt tells Claude not to commit — Hopper handles all git operations
- Updated coordinator skill with comprehensive CLI coverage

## [0.5.0] - 2026-03-06

### Changed

- Rewrote hopper-coordinator skill to focus on dispatching concrete work to background agents, with guardrails against misuse as a to-do list
- Made `--dir`/`--branch` the primary usage pattern in coordinator skill docs and examples

### Removed

- hopper-worker skill (superseded by `hopper worker` command)
- `hopper init` now removes the deprecated worker skill from target projects

## [0.4.3] - 2026-03-04

### Fixed

- Worktree setup when the target branch doesn't yet exist

## [0.4.2] - 2026-03-03

### Fixed

- Robust worktree handling with auto-commit and merge-back in hopper worker
- Worktree add when branch is already checked out elsewhere

## [0.4.0] - 2026-03-03

### Added

- `hopper worker` command — runs the claim/work/complete cycle with isolated git worktrees, replacing `claude_worker.sh`
- `--branch` flag on `add` command (required with `--dir`) for worktree-based isolation
- Audit logging to `~/.hopper/audit/`

### Removed

- `claude_worker.sh` script (replaced by `hopper worker`)

### Changed

- Updated dependencies to latest versions

## [0.3.3] - 2026-02-24

### Changed

- Extract `resolveItem` helper to eliminate duplicated ID resolution logic
- Move audit logs to dedicated directory
- Update workspace paths
- Update transitive dependencies

## [0.3.2] - 2026-02-16

### Added

- MIT license
- `src/constants.ts` as single source of truth for VERSION and item status constants

### Changed

- Extract item status literals into `Status` const object, replacing ~20 scattered string literals
- Extract fallback title truncation length into named constant in titler
- Consolidate VERSION declaration — single definition in `constants.ts`, eliminating circular dependency between `cli.ts` and `init.ts`
- Remove openclaw notification from claude_worker script after completing Claude session

## [0.3.1] - 2026-02-14

### Added

- SKILL.md files for hopper-coordinator and hopper-worker skills
- AGENTS.md for project guidance

## [0.3.0] - 2026-02-14

### Added

- `--dir` flag for specifying task working directory
- `--result` flag on `complete` command for recording task outcomes
- `init` command to install skill files into target repositories
- `show` command to display full item details
- `cancel` command to cancel in-progress items
- `claude_worker.sh` script to orchestrate the claim-work-complete cycle with Claude
- SKILL.md for writing cross-agent compatible skills
- Pre-push git hook to run lint and tests before pushing
- Skill file embedding via Bun text imports at build time

### Changed

- `list` command now shows claim tokens for in-progress items
- `add` command now outputs item ID after creation

## [0.2.1] - 2026-02-14

### Fixed

- TypeScript strict null check in requeue prefix matching

## [0.2.0] - 2026-02-14

### Added

- Claim lifecycle: `claim`, `complete`, and `requeue` commands
- Claim tokens (UUID) to prevent completing items you didn't claim
- ID prefix matching for `claim`, `complete`, `requeue`, and `cancel` commands

## [0.1.1] - 2026-02-14

### Changed

- Replace Mojentic dependency with direct OpenAI API call for title generation (zero runtime dependencies)

## [0.1.0] - 2026-02-14

### Added

- Initial implementation of hopper CLI
- `add` command to queue new work items with LLM-generated titles
- `list` command to display queued, in-progress, and completed items
- `next` command to dequeue the next item
- JSON file storage at `~/.hopper/items.json`
- `--json` flag for machine-readable output on all commands
- Cross-platform build targets (macOS, Linux, Windows)

### Fixed

- Release workflow: use macos-14 for x64 builds

[Unreleased]: https://github.com/svetzal/hopper/compare/v4.1.0...HEAD
[4.1.0]: https://github.com/svetzal/hopper/compare/v4.0.1...v4.1.0
[3.3.0]: https://github.com/svetzal/hopper/compare/v3.2.0...v3.3.0
[3.2.0]: https://github.com/svetzal/hopper/compare/v3.1.1...v3.2.0
[3.1.1]: https://github.com/svetzal/hopper/compare/v3.1.0...v3.1.1
[3.1.0]: https://github.com/svetzal/hopper/compare/v3.0.0...v3.1.0
[3.0.0]: https://github.com/svetzal/hopper/compare/v2.1.4...v3.0.0
[2.1.4]: https://github.com/svetzal/hopper/compare/v2.1.3...v2.1.4
[2.1.3]: https://github.com/svetzal/hopper/compare/v2.1.2...v2.1.3
[2.1.2]: https://github.com/svetzal/hopper/compare/v2.1.1...v2.1.2
[2.1.1]: https://github.com/svetzal/hopper/compare/v2.1.0...v2.1.1
[2.1.0]: https://github.com/svetzal/hopper/compare/v2.0.7...v2.1.0
[2.0.7]: https://github.com/svetzal/hopper/compare/v2.0.6...v2.0.7
[2.0.6]: https://github.com/svetzal/hopper/compare/v2.0.5...v2.0.6
[2.0.5]: https://github.com/svetzal/hopper/compare/v2.0.4...v2.0.5
[2.0.4]: https://github.com/svetzal/hopper/compare/v2.0.3...v2.0.4
[2.0.3]: https://github.com/svetzal/hopper/compare/v2.0.2...v2.0.3
[2.0.2]: https://github.com/svetzal/hopper/compare/v2.0.1...v2.0.2
[2.0.1]: https://github.com/svetzal/hopper/compare/v2.0.0...v2.0.1
[2.0.0]: https://github.com/svetzal/hopper/compare/v1.5.2...v2.0.0
[1.5.2]: https://github.com/svetzal/hopper/compare/v1.5.1...v1.5.2
[1.5.1]: https://github.com/svetzal/hopper/compare/v1.5.0...v1.5.1
[1.1.0]: https://github.com/svetzal/hopper/compare/v1.0.2...v1.1.0
[1.0.0]: https://github.com/svetzal/hopper/compare/v0.5.0...v1.0.0
[0.5.0]: https://github.com/svetzal/hopper/compare/v0.4.3...v0.5.0
[0.4.3]: https://github.com/svetzal/hopper/compare/v0.4.2...v0.4.3
[0.4.2]: https://github.com/svetzal/hopper/compare/v0.4.0...v0.4.2
[0.4.0]: https://github.com/svetzal/hopper/compare/v0.3.3...v0.4.0
[0.3.3]: https://github.com/svetzal/hopper/compare/v0.3.2...v0.3.3
[0.3.2]: https://github.com/svetzal/hopper/compare/v0.3.1...v0.3.2
[0.3.1]: https://github.com/svetzal/hopper/compare/v0.3.0...v0.3.1
[0.3.0]: https://github.com/svetzal/hopper/compare/v0.2.1...v0.3.0
[0.2.1]: https://github.com/svetzal/hopper/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/svetzal/hopper/compare/v0.1.1...v0.2.0
[0.1.1]: https://github.com/svetzal/hopper/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/svetzal/hopper/releases/tag/v0.1.0
