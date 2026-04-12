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
| `src/list-workflow.ts` | Pure functions for the list command: `filterAndSortItems`, `formatItemList`, `itemTiming` |
| `src/command-result.ts` | `CommandResult` discriminated union type returned by all commands |
| `src/command-flags.ts` | `stringFlag` and `booleanFlag` helpers for typed flag extraction |
| `src/command-runner.ts` | `runCommand` — handles JSON/human output branching, warning display, error exit codes |
| `src/gateways/git-gateway.ts` | `GitGateway` interface + real implementation (thin wrapper around `git` subprocesses via `Bun.spawn`) |
| `src/gateways/claude-gateway.ts` | `ClaudeGateway` interface + real implementation (thin wrapper around the `claude` CLI process) |
| `src/gateways/fs-gateway.ts` | `FsGateway` interface + real implementation (thin wrapper around `mkdir` and `Bun.write`) |
| `src/gateways/store-gateway.ts` | `StoreGateway` interface + real implementation (thin wrapper around `Bun.file`/`Bun.write` for `~/.hopper/items.json`) |
| `src/gateways/preset-gateway.ts` | `PresetGateway` interface + real implementation (thin wrapper around `Bun.file`/`Bun.write` for `~/.hopper/presets.json`) |
| `src/gateways/llm-gateway.ts` | `LlmGateway` interface + real implementation (thin wrapper around OpenAI `fetch` for chat completions) |
| `src/gateways/init-gateway.ts` | `InitGateway` interface + real implementation (thin wrapper around `Bun.file`, `Bun.write`, `mkdir`, and `rm` for skill file installation) |
| `src/commands/*.ts` | One file per CLI command, each returns `CommandResult` |
| `src/text-imports.d.ts` | Type declaration for Bun's `*.md` text imports |

### Key patterns

- **Claim tokens**: `claim` generates a `claimToken` (UUID) that must be passed to `complete`. This prevents completing items you didn't claim
- **ID prefix matching**: `findItem`, `requeueItem`, and `cancelItem` accept UUID prefixes (e.g. first 8 chars)
- **`--json` flag**: All commands support `--json` for machine-readable output. Human-friendly output is the default
- **Skill embedding**: `hopper init` installs `.claude/skills/` files into target repos. The SKILL.md content is embedded at build time via Bun text imports from `skills/`
- **Gateway pattern**: I/O operations are isolated behind gateway interfaces. `GitGateway`, `ClaudeGateway`, and `FsGateway` serve the worker command. `StoreGateway` encapsulates `~/.hopper/items.json` file access used by `store.ts`. `PresetGateway` encapsulates `~/.hopper/presets.json` file access used by `presets.ts`. `LlmGateway` wraps the OpenAI fetch call used by `titler.ts`. `InitGateway` wraps all file system operations used by `init.ts`. Gateway implementations in `src/gateways/` are thin wrappers with no business logic. All workflow decisions live in pure functions (`src/worker-workflow.ts`, `src/store-workflow.ts`, etc.)
- **Command results**: Commands in `src/commands/` return `CommandResult` (discriminated union from `src/command-result.ts`) instead of calling `console.log`/`process.exit` directly. The `runCommand()` function in `src/command-runner.ts` handles JSON/human output branching, warning display, and error exit codes. This keeps commands testable as pure functions. Exceptions: `worker.ts` (long-running loop) and `init.ts` (unique interface) manage their own I/O.

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

CI does the rest automatically on tag push:
- Runs tests and type-check
- Cross-compiles binaries (macOS arm64/x64, Linux x64, Windows x64)
- Creates a GitHub Release with tarballs and release notes
- Updates the Homebrew tap (`svetzal/homebrew-tap`) formula

Use semver: patch for bug fixes, minor for new features, major for breaking changes.

## Mojility context

This is a Mojility internal project at `~/Work/Projects/Mojility/hopper/`. Client code for issue tracking is `mojility`.
