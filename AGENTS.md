# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What is Hopper?

Hopper is a personal work queue CLI that distributes tasks to AI agents. Items flow through: `queued -> in_progress -> completed` (with requeue and cancel paths). It's a Bun/TypeScript CLI tool that compiles to standalone binaries.

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
| `src/commands/*.ts` | One file per CLI command, each exports a single async function |
| `src/text-imports.d.ts` | Type declaration for Bun's `*.md` text imports |

### Key patterns

- **Claim tokens**: `claim` generates a `claimToken` (UUID) that must be passed to `complete`. This prevents completing items you didn't claim
- **ID prefix matching**: `findItem`, `requeueItem`, and `cancelItem` accept UUID prefixes (e.g. first 8 chars)
- **`--json` flag**: All commands support `--json` for machine-readable output. Human-friendly output is the default
- **Skill embedding**: `hopper init` installs `.claude/skills/` files into target repos. The SKILL.md content is embedded at build time via Bun text imports from `skills/`

### Worker integration

`claude_worker.sh` is a shell script that orchestrates the claim-work-complete cycle: claims an item via `hopper claim --json`, runs a `claude --print` session with the task description, then calls `hopper complete` or `hopper requeue` based on exit status.

## Mojility context

This is a Mojility internal project at `~/Work/Projects/Mojility/hopper/`. Client code for issue tracking is `mojility`.
