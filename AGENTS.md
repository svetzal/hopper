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
|------|---------|
| `src/cli.ts` | Entry point, arg parser, command dispatch |
| `src/store.ts` | All data operations (load, save, claim, complete, requeue, cancel, find). Module-level `storeDir` set via `setStoreDir()` for testing |
| `src/format.ts` | Display helpers (relative time, duration, short ID) |
| `src/titler.ts` | LLM title generation via OpenAI API (gpt-4.1-nano). Falls back to truncation if no `OPENAI_API_KEY` |
| `src/extract-result.ts` | Pure JSONL parser that extracts the final result string from a Claude `stream-json` session |
| `src/worker-workflow.ts` | Pure decision functions for the worker: work setup, prompt building, auto-commit, merge, completion decisions, worker config parsing, loop action resolution, and shutdown action |
| `src/gateways/git-gateway.ts` | `GitGateway` interface + real implementation (thin wrapper around `git` subprocesses via `Bun.spawn`) |
| `src/gateways/claude-gateway.ts` | `ClaudeGateway` interface + real implementation (thin wrapper around the `claude` CLI process) |
| `src/gateways/fs-gateway.ts` | `FsGateway` interface + real implementation (thin wrapper around `mkdir` and `Bun.write`) |
| `src/commands/*.ts` | One file per CLI command, each exports a single async function |
| `src/text-imports.d.ts` | Type declaration for Bun's `*.md` text imports |

### Key patterns

- **Claim tokens**: `claim` generates a `claimToken` (UUID) that must be passed to `complete`. This prevents completing items you didn't claim
- **ID prefix matching**: `findItem`, `requeueItem`, and `cancelItem` accept UUID prefixes (e.g. first 8 chars)
- **`--json` flag**: All commands support `--json` for machine-readable output. Human-friendly output is the default
- **Skill embedding**: `hopper init` installs `.claude/skills/` files into target repos. The SKILL.md content is embedded at build time via Bun text imports from `skills/`
- **Gateway pattern**: The worker command's I/O operations (git subprocesses, Claude CLI, filesystem writes) are isolated behind `GitGateway`, `ClaudeGateway`, and `FsGateway` interfaces. The worker accepts these as optional deps for testing. Gateway implementations in `src/gateways/` are thin wrappers with no business logic. All workflow decisions live in the pure functions in `src/worker-workflow.ts`

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

The version number lives in two places that must stay in sync:

- `package.json` — `"version"` field
- `src/constants.ts` — `VERSION` constant (this is what `hopper --version` returns)

To cut a release:

1. Update `CHANGELOG.md` — add a new `## [x.y.z] - YYYY-MM-DD` section under `[Unreleased]`
2. Update the version in both `package.json` and `src/constants.ts`
3. Commit all changes with message: `Release vX.Y.Z`
4. Tag the commit: `git tag vX.Y.Z`
5. Push commit and tag: `git push && git push --tags`

Use semver: patch for bug fixes, minor for new features, major for breaking changes.

## Mojility context

This is a Mojility internal project at `~/Work/Projects/Mojility/hopper/`. Client code for issue tracking is `mojility`.
