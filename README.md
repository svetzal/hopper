# Hopper

A personal work queue CLI that distributes tasks to AI agents.

Work items flow through a simple lifecycle:

```
queued → (claim) → in_progress → (complete) → completed
  ↑                                    │
  └──────── (requeue) ────────────────┘
```

## Quick Start

```bash
# Add a task to the queue
hopper add "Refactor the authentication module to use JWT tokens"

# See what's queued
hopper list

# Claim the next task (as a worker)
hopper claim --agent "worker-1" --json

# Complete it
hopper complete <claimToken> --agent "worker-1" --result "Refactored auth to JWT"

# Or requeue if something went wrong
hopper requeue <id> --reason "Missing database credentials"
```

## Installation

### From source

Requires [Bun](https://bun.sh) v1.0+.

```bash
bun install
bun run build        # → build/hopper
```

### Cross-platform builds

```bash
bun run build:all    # macOS (arm64, x64), Linux (x64), Windows (x64)
```

Binaries are standalone — no runtime needed on the target machine.

## Commands

| Command | Description |
|---------|-------------|
| `add <description>` | Queue a new work item (auto-generates a title via LLM) |
| `show <id>` | Display full details of an item |
| `list` | Show queued and in-progress items |
| `claim` | Claim the next queued item (FIFO) |
| `complete <token>` | Mark a claimed item as completed |
| `requeue <id>` | Return an in-progress item to the queue |
| `cancel <id>` | Cancel a queued item |
| `init` | Install Claude Code skill files into the current repo |

### Options

- `--json` — Machine-readable JSON output (all commands)
- `--dir <path>` — Working directory for the task (`add`)
- `--agent <name>` — Agent identity (`claim`, `complete`, `requeue`)
- `--result "..."` — Attach a result summary (`complete`)
- `--reason "..."` — Explain why an item is being requeued (`requeue`)
- `--all` — Include completed items (`list`)
- `--completed` — Show only completed items (`list`)

## How It Works

### Storage

All data lives in `~/.hopper/items.json` — a flat JSON array of work items. No database, no server.

### Claim tokens

When an agent claims a work item, Hopper generates a UUID claim token. That token must be passed back to `complete` the item. This prevents one agent from completing another agent's work.

### ID prefix matching

You don't need full UUIDs. Any unique prefix works:

```bash
hopper show a3f8       # matches a3f8c2d1-...
hopper cancel a3       # matches if unambiguous
```

### Title generation

`hopper add` auto-generates a short title from the description using the OpenAI API (gpt-4.1-nano). Set `OPENAI_API_KEY` in your environment, or it falls back to truncating the description.

## Agent Integration

Hopper is designed to be driven by AI agents. There are two roles:

### Coordinator

Breaks down work into discrete tasks and adds them to the queue. Run `hopper init` in a target repo to install the coordinator skill for Claude Code.

### Worker

Claims items, executes the described task, and reports back. The included `claude_worker.sh` script automates this loop:

1. Claims the next item via `hopper claim --json`
2. Runs a `claude --print` session with the task description
3. Calls `hopper complete` on success or leaves the item for manual requeue on failure
4. Polls for more work

```bash
# Start an automated worker
AGENT_NAME=my-worker ./claude_worker.sh
```

Environment variables for the worker:
- `AGENT_NAME` — Worker identity (default: `claude-worker`)
- `HOPPER` — Path to the hopper binary (default: `hopper`)
- `POLL_INTERVAL` — Seconds between queue checks (default: `60`)

## Development

```bash
bun install              # Install dependencies
bun test                 # Run all tests
bun test src/store.test  # Run a single test file
bun run lint             # Type-check (tsc --noEmit)
bun run dev              # Run CLI in dev mode
```

A pre-push hook runs lint and tests automatically.

### Project structure

```
src/
  cli.ts              # Entry point, arg parser, command dispatch
  store.ts            # Data operations (load, save, claim, complete, ...)
  format.ts           # Display helpers (relative time, duration, short ID)
  titler.ts           # LLM title generation via OpenAI API
  commands/           # One file per CLI command
skills/
  hopper-coordinator/ # Coordinator skill (SKILL.md)
  hopper-worker/      # Worker skill (SKILL.md)
claude_worker.sh      # Automated claim-work-complete loop
```

Zero runtime dependencies. Built entirely on Bun APIs.

## License

Internal project — Mojility Inc.
