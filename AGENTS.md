# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What is Hopper?

Hopper is a personal work queue CLI that distributes tasks to AI agents. Items flow through: `queued -> in_progress -> completed` (with requeue and cancel paths). It's a Bun/TypeScript CLI tool that compiles to standalone binaries.

See the product @CHARTER.md for more details about the product and purpose.

## Commands

```bash
bun install              # Install dependencies
bun test                 # Run all tests
bun test src/store.test  # Run a single test file
bun run lint             # Type-check (tsc --noEmit)
bun run dev              # Run CLI in dev mode
bun run build            # Compile to build/hopper
bun run build:all        # Cross-compile for macOS, Linux, Windows
```

A pre-push hook runs `bun run lint` and `bun test` automatically.

## Architecture

- **Runtime**: Bun (not Node). Uses `Bun.file()`, `Bun.write()`, `Bun.stdin`, `bun:test`, and Bun text imports (`with { type: "text" }`)
- **No framework/deps**: Zero runtime dependencies. Hand-rolled arg parsing in `cli.ts`, direct `fetch` to OpenAI API for title generation
- **Storage**: JSON file at `~/.hopper/items.json`. Single flat array of `Item` objects. No database

### Source layout

| File | Purpose |
| ---- | ------- |
| `src/cli.ts` | Entry point, arg parser, command dispatch |
| `src/store.ts` | I/O shell for data operations (load, save, claim, complete, requeue, cancel, find). Delegates all logic to `store-workflow.ts`. Module-level gateway updated via `setStoreDir()` for testing |
| `src/store-workflow.ts` | Pure functions for all store domain logic: `claimNext`, `complete`, `requeue`, `cancel`, `reprioritize`, `addTags`, `removeTags`, `prependItem`, `resolveItem` |
| `src/format.ts` | Display helpers (relative time, duration, short ID, `formatItemDetail`) |
| `src/titler.ts` | LLM title generation via OpenAI API (gpt-4.1-nano). Falls back to truncation if no `OPENAI_API_KEY` |
| `src/extract-result.ts` | Pure JSONL parser that extracts the final result string from a Claude `stream-json` session |
| `src/worker-workflow.ts` | Pure decision functions for the worker: work setup, prompt building, auto-commit, merge, completion decisions, worker config parsing, loop action resolution, and shutdown action |
| `src/engineering-workflow.ts` | Pure functions for the engineering pipeline: `buildEngineeringTranscript`, `buildEngineeringFailureResult`, `resolveEngineeringCommitFallback` |
| `src/list-workflow.ts` | Pure functions for the list command: `filterAndSortItems`, `formatItemList`, `itemTiming` |
| `src/command-result.ts` | `CommandResult` discriminated union type returned by all commands |
| `src/command-flags.ts` | `stringFlag` and `booleanFlag` helpers for typed flag extraction |
| `src/command-runner.ts` | `runCommand` — handles JSON/human output branching, warning display, error exit codes |
| `src/gateways/git-gateway.ts` | `GitGateway` interface + real implementation (thin wrapper around `git` subprocesses via `Bun.spawn`) |
| `src/gateways/agent-runner.ts` | Runner-agnostic `AgentRunner` and `SessionOptions` interfaces — the seam between the worker and the two concrete runners |
| `src/gateways/claude-gateway.ts` | `AgentRunner` implementation backed by the `claude` CLI. `ClaudeGateway`/`ClaudeSessionOptions` are legacy aliases of the runner-agnostic types |
| `src/gateways/opencode-gateway.ts` | `AgentRunner` implementation backed by the `opencode` CLI. Streams to the audit file, side-loads `opencode export` for the canonical result, and decides outcome on (exit code AND no error events). `generateText` (branch slug / commit message / validate fallback) is delegated to the claude runner |
| `src/gateways/opencode-argv.ts` | Pure argv builder for `opencode run --format json` invocations |
| `src/gateways/opencode-config-content.ts` | Synthesises the `OPENCODE_CONFIG_CONTENT` env var that inlines a craftsperson agent definition for opencode |
| `src/gateways/audit-stream.ts` | Shared `streamToAuditFile` used by both runners — writes each JSONL line as it arrives so coordinators can watch progress in real time |
| `src/gateways/runner-config.ts` | Loads `~/.hopper/runner-config.json` and resolves model tiers (`deep`/`balanced`/`fast`) to opencode-native model IDs |
| `src/gateways/model-tier.ts` | Vendor-agnostic tier vocabulary (`deep`/`balanced`/`fast`) and the claude-side tier→`opus|sonnet|haiku` translation |
| `src/extract-opencode-result.ts` | Pure parser for opencode JSONL streams (session ID + error events) and `opencode export` documents (final assistant text) |
| `src/craftsperson-body.ts` | Pure extractor for the system-prompt body of a `~/.claude/agents/<name>.md` craftsperson file (used when inlining into opencode) |
| `src/gateways/fs-gateway.ts` | `FsGateway` interface + real implementation (thin wrapper around `mkdir` and `Bun.write`) |
| `src/gateways/store-gateway.ts` | `StoreGateway` interface + real implementation (thin wrapper around `Bun.file`/`Bun.write` for `~/.hopper/items.json`) |
| `src/gateways/preset-gateway.ts` | `PresetGateway` interface + real implementation (thin wrapper around `Bun.file`/`Bun.write` for `~/.hopper/presets.json`) |
| `src/gateways/llm-gateway.ts` | `LlmGateway` interface + real implementation (thin wrapper around OpenAI `fetch` for chat completions) |
| `src/gateways/init-gateway.ts` | `InitGateway` interface + real implementation (thin wrapper around `Bun.file`, `Bun.write`, `mkdir`, and `rm` for skill file installation) |
| `src/commands/worker.ts` | Generic-item flow (`handleCompletion`, `commitWorktreeChanges`, `executeWork`) + `processItem` dispatcher that delegates engineering items to `worker-engineering.ts` |
| `src/commands/worker-engineering.ts` | Engineering pipeline imperative shell: `runPlanPhase`, `runExecuteValidateLoop`, `commitEngineeringChanges`, `teardownMergeAndComplete`, `processEngineeringItem` |
| `src/commands/worker-loop.ts` | Worker loop entry point: `WorkerLoopDeps`, `runWorkerLoop`, `workerCommand` — the poll/claim/dispatch cycle and CLI entry |
| `src/commands/worker-shared.ts` | Shared orchestration helpers used by both worker flows: `createLogger`, `orchestrateWorktreeSetup`, `orchestrateMerge`, `mergeAndPush`, `teardownWorktree` |
| `src/commands/*.ts` | One file per CLI command, each returns `CommandResult` |
| `src/text-imports.d.ts` | Type declaration for Bun's `*.md` text imports |

### Key patterns

- **Claim tokens**: `claim` generates a `claimToken` (UUID) that must be passed to `complete`. This prevents completing items you didn't claim
- **ID prefix matching**: `findItem`, `requeueItem`, and `cancelItem` accept UUID prefixes (e.g. first 8 chars)
- **`--json` flag**: All commands support `--json` for machine-readable output. Human-friendly output is the default
- **Skill embedding**: `hopper init` installs `.claude/skills/` files into target repos. The SKILL.md content is embedded at build time via Bun text imports from `skills/`
- **Investigation sandbox**: Investigation items run with the full `Bash` tool plus `INVESTIGATION_DISALLOWED_TOOLS` (in `src/task-type-workflow.ts`) which blocks git mutations, hopper queue mutations, foundry/evt mutators, package installers, network-egress CLIs, and destructive filesystem verbs. Brief authors can assume read access to `hopper show|list|audit|history`, `git log|status|diff|show|rev-parse|blame`, `git worktree list`, `jq`, `cat|ls|head|tail|wc|find|grep|rg|awk|sed`, `foundry history|trace`, and `evt query|aggregate`. Note: `Bash(git branch:*)` is denied (blocks `-d|-D` mutations but also `--list`); use `git for-each-ref refs/heads` instead. `Bash(git stash:*)` similarly blocks `stash list`; use `git log refs/stash`. `permissionMode: "plan"` is **not** applied — the denylist is the control surface. The opencode runner currently ignores `disallowedTools` (tracked as a separate gap).
- **Agent runners**: Hopper supports two interchangeable runners via the `AgentRunner` interface in `src/gateways/agent-runner.ts` — Claude Code (default) and opencode. Selection happens at worker startup via `hopper worker --runner claude|opencode`. The opencode runner translates hopper's session options to opencode's surface (no CLI tool/permission flags exist; craftsperson agents inline via `OPENCODE_CONFIG_CONTENT`; model tiers resolve through `~/.hopper/runner-config.json`). Fast-tier one-shots (`generateText`) always run on claude regardless of runner choice — opencode adds no value to deterministic branch-slug/commit-message generation. See `docs/opencode-spike.md` for the empirical CLI findings that shaped the implementation.
- **Model tiers**: Hopper addresses models through a vendor-agnostic three-tier vocabulary (`deep`, `balanced`, `fast` — defined in `src/gateways/model-tier.ts`) chosen per phase in `src/task-type-workflow.ts`. Claude translates tier→native alias via a hard-coded map; opencode translates via the per-user runner-config. Runner-native strings (e.g. `openai/gpt-5.5`) pass through both runners untranslated, so an advanced caller can still pin a specific model.
- **Gateway pattern**: I/O operations are isolated behind gateway interfaces. `GitGateway`, `AgentRunner` (with `claude-gateway`/`opencode-gateway` implementations), and `FsGateway` serve the worker command. `StoreGateway` encapsulates `~/.hopper/items.json` file access used by `store.ts`. `PresetGateway` encapsulates `~/.hopper/presets.json` file access used by `presets.ts`. `LlmGateway` wraps the OpenAI fetch call used by `titler.ts`. `InitGateway` wraps all file system operations used by `init.ts`. Gateway implementations in `src/gateways/` are thin wrappers: they perform I/O and may compose I/O results with pure functions (imperative-shell role), but they contain no domain decisions. Domain rules — exit-code interpretation (`resolveEffectiveExitCode`), session-preamble construction (`buildSessionPreamble`), env-record synthesis (`resolveOpencodeEnv`) — live in the pure-function layer (`src/extract-result.ts`, `src/extract-opencode-result.ts`, `src/gateways/opencode-config-content.ts`, etc.).
- **Command results**: Commands in `src/commands/` return `CommandResult` (discriminated union from `src/command-result.ts`) instead of calling `console.log`/`process.exit` directly. The `runCommand()` function in `src/command-runner.ts` handles JSON/human output branching, warning display, and error exit codes. This keeps commands testable as pure functions. Exceptions: `worker.ts` (long-running loop) and `init.ts` (unique interface) manage their own I/O.
- **Error handling strategy**: Three distinct layers — never call `console.error` outside `command-runner.ts`:
  1. **Gateway layer** (`src/gateways/`): Silent catch-and-return-empty/null. Missing files, unreadable directories, and parse failures return neutral defaults. No logging.
  2. **Command layer** (`src/commands/` returning `CommandResult`): Check `Result` values from store functions directly and return `{ status: "error", message: ... }` inline. Surface partial failures via `warnings` on `CommandResult`. Only `command-runner.ts` writes to stderr — commands never call `console.error` directly.
  3. **Worker layer** (`worker-loop.ts`, `worker-engineering.ts`, `worker-shared.ts`): Use the injected `log`/`LogFn` callback for all output including errors. Three sub-layers:
     - **`safe*` helpers** (`safeRecordPhase`, `safeRequeue`, `safePersistBranchSlug`, `resolveEngineeringBranchSlug`, `resolveEngineeringCommitMessage`): Catch all exceptions, log via optional `log` callback, return neutral fallback or void. Never throw.
     - **Orchestration functions** (`processItem`, `processEngineeringItem`, `teardownMergeAndComplete`, `commitEngineeringChanges`): Let exceptions propagate. Use try/finally only for resource cleanup. Pre-spawn setup in `processEngineeringItem` auto-requeues via `safeRequeue` on failure and returns early; post-spawn failures propagate to the worker loop.
     - **Worker loop** (`runWorkerLoop`): Catches all exceptions from `processItem` via `.catch()`, calls `safeRequeue` as last-resort via `requeueIfStillClaimed`, never crashes the loop.

### Skill Distribution

- **Source of truth**: `skills/` directory in the repo. Each skill has a `SKILL.md` that is embedded at build time via Bun text imports
- **Install command**: `hopper init [--global] [--force]` copies skill files into `.claude/skills/` (local repo) or `~/.claude/skills/` (global)
- **Version stamping**: The `VERSION` constant from `src/constants.ts` is written into SKILL.md frontmatter as `hopper-version` at install time
- **Version guard**: `hopper init` refuses to overwrite an installed skill that has a newer `hopper-version` than the running binary. Use `--force` to downgrade
- **Release note**: Skill content updates are automatically picked up via embedded imports — no manual version bump needed for skill-only changes

### Linting and Formatting

The project uses [Biome](https://biomejs.dev/) for linting and formatting. Run `bun run lint` (type-check + Biome check) before pushing. Run `bun run format` to auto-fix style issues.

### Worker integration

`claude_worker.sh` is a shell script that orchestrates the claim-work-complete cycle: claims an item via `hopper claim --json`, runs a `claude --print` session with the task description, then calls `hopper complete` or `hopper requeue` based on exit status.

## Local Installation

```bash
brew tap svetzal/tap
brew install hopper
```

To upgrade: `brew upgrade hopper`

## Branching model

Trunk-based development: `main` is the only long-lived branch. All work lands on `main` via direct commit. Feature branches are not pushed to `origin`. Pull requests are not used. Short-lived local working branches (e.g. from hopper worktrees) are merged to `main` and deleted locally before work is considered complete.

## Documentation site

Hopper publishes a [VitePress](https://vitepress.dev) site to GitHub Pages
at <https://svetzal.github.io/hopper/>. Source lives in `docs/`:

- `docs/index.md` — landing page
- `docs/migration-2.x-to-3.x.md` — upgrade guide
- `docs/opencode-spike.md` — empirical findings from the opencode CLI investigation
- `docs/.vitepress/config.ts` — site config (nav, sidebar, theme)

Local commands:

```bash
bun run docs:dev      # live-reload server on http://localhost:5173
bun run docs:build    # static build into docs/.vitepress/dist
bun run docs:preview  # serve the production build for spot-checking
```

`.github/workflows/docs.yml` builds and deploys on every push to `main`
that touches `docs/**` (or the workflow file itself, or
`package.json`/`bun.lock`). The deployment is idempotent and uses
`actions/deploy-pages@v4`; the `pages` concurrency group ensures only one
deploy runs at a time.

**Markdown gotcha**: VitePress runs markdown through Vue's compiler, so
bare `<id>` / `<name>` placeholders outside of fenced code or inline
backticks get parsed as HTML and fail the build. Keep angle-bracket
placeholders inside backticks (`` `<id>` ``) or escape them
(`\<id\>`). Single-line inline code only — backticks don't span
newlines, and a stray cross-line ` `…\n…` ` will likewise break the
build.

## Release process

The version number lives in three places that must stay in sync:

- `package.json` — `"version"` field
- `src/constants.ts` — `VERSION` constant (this is what `hopper --version` returns)
- `skills/hopper-coordinator/SKILL.md` — `metadata.version` in frontmatter (the `init` command also stamps this at install time, so the installed skill always reflects the binary version)

To create a new release:

1. Pre-flight — ensure all quality gates pass: `bun test && bun run lint`
2. Update `CHANGELOG.md` — move `[Unreleased]` items to a new `## [x.y.z] - YYYY-MM-DD` section
3. Bump the version in `package.json`, `src/constants.ts`, and `skills/hopper-coordinator/SKILL.md`
4. Review skill files in `skills/` — ensure content is current for the release
5. Commit all changes with message: `Release vX.Y.Z`
6. Tag the commit: `git tag vX.Y.Z`
7. Push: `git push origin main --tags`
8. Install locally without waiting for Homebrew:

   ```bash
   bun run build
   mkdir -p ~/.local/bin
   cp build/hopper ~/.local/bin/hopper
   codesign --force --sign - ~/.local/bin/hopper
   ```

   **Always install to `~/.local/bin/hopper`** — never to a Homebrew-managed path like `/opt/homebrew/bin/hopper` or `/usr/local/bin/hopper`, which would stomp on the brew-installed binary and break brew's state. Make sure `~/.local/bin` sits ahead of the Homebrew bin directory in your `PATH` so this install wins over the released version. `which hopper` should report `~/.local/bin/hopper`; if it reports a Homebrew path instead, fix your `PATH` ordering rather than installing elsewhere.

   **The `codesign --force --sign -` step is required on macOS.** Bun's `--compile` embeds an ad-hoc signature that becomes invalid once the file is copied (macOS attaches a `com.apple.provenance` xattr on copy, which desyncs the embedded hash). Without an ad-hoc re-sign, the kernel SIGKILLs the process on launch with no useful error — you just see `[1] <pid> killed hopper ...`. Verify with `codesign --verify --verbose=2 ~/.local/bin/hopper`.

9. Refresh the globally-installed coordinator skill:

   ```bash
   hopper init --global
   ```

   The `hopper` binary embeds the skill content at build time, but installing the binary does not by itself update the copy at `~/.claude/skills/hopper-coordinator/SKILL.md` that Claude Code loads. `hopper init --global` copies the embedded skill into place and stamps `metadata.version` and `hopper-version` from the running binary's `VERSION`. Running it as the last release step guarantees the global skill never lags behind the binary. The newer-binary-over-older-skill direction needs no `--force`; the version guard only blocks the reverse.

   **Note for the in-flight Claude Code session:** the skill is loaded at session start, so a session that began before the release will keep using the old skill until you restart Claude Code (or open a new session). New sessions and other agents on the machine pick up the new skill immediately.

CI does the rest automatically on tag push:
- Runs tests and type-check
- Cross-compiles binaries (macOS arm64/x64, Linux x64, Windows x64)
- Creates a GitHub Release with tarballs and release notes
- Updates the Homebrew tap (`svetzal/homebrew-tap`) formula

Use semver: patch for bug fixes, minor for new features, major for breaking changes.

## Mojility context

This is a Mojility internal project at `~/Work/Projects/Mojility/hopper/`. Client code for issue tracking is `mojility`.
