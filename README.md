# Hopper

A personal work queue CLI that distributes tasks to AI agents and shell commands.

Work items flow through a simple lifecycle:

```
queued → (claim) → in_progress → (complete) → completed
  ↑                     │
  │                     └─ (fail) → failed   (worktree preserved for recovery)
  └──────── (requeue) ──────────────┘
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
| `audit <id>` | Show audit summary, decoded event tail, plan, or result for an item |
| `show <id>` | Display full details of an item |
| `list` | Show queued and in-progress items |
| `claim` | Claim the next queued item (FIFO) |
| `complete <token>` | Mark a claimed item as completed |
| `requeue <id>` | Return an in-progress or failed item to the queue |
| `integrate <id>` | Merge item's branch into main of workingDir and clean up worktree/branch |
| `cancel <id>` | Cancel a queued, in-progress, or failed item (tears down any worktree/branch) |
| `init` | Install the Hopper coordinator skill into `~/.claude/skills/` by default |

### Options

- `--json` — Machine-readable JSON output (all commands)
- `--dir <path>` — Working directory for the task (`add`)
- `--command <cmd>` — Shell command to execute instead of Claude (`add`)
- `--agent <name>` — Agent identity (`claim`, `complete`, `requeue`)
- `--result "..."` — Attach a result summary (`complete`)
- `--reason "..."` — Explain why an item is being requeued (`requeue`)
- `--every <duration>` — Make recurring (e.g. `4h`, `1d`). Minimum 5 minutes (`add`)
- `--times <n>` — Limit recurrences to n total runs, requires `--every` (`add`)
- `--until <timespec>` — End date for recurrence, requires `--every` (`add`)
- `--tail <n>` — Last N decoded session events (`audit`)
- `--plan` — Show the engineering plan markdown (`audit`)
- `--result` — Show the final result or in-progress placeholder (`audit`)
- `--phase <name>` — Restrict audit to one phase, e.g. `execute` (`audit`, engineering items only)
- `--all` — Include completed items (`list`)
- `--completed` — Show only completed items (`list`)
- `--dry-run` — Print the git commands without executing them (`integrate`)
- `--keep-worktree` — Leave worktree and branch in place after merge (`integrate`)

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

## Agent Runners

The `hopper worker` loop dispatches each item through the runner selected by its
profile (`hopper add --profile <name>`; defaults come from
`~/.hopper/config.json`). Shipped profiles cover three agent runners:

- **`claude`** — uses the [Claude Code](https://www.anthropic.com/claude/claude-code) CLI. Hopper passes craftsperson references via `--agent`, tool allowlists/denylists via `--tools`/`--allowedTools`/`--disallowedTools`, and parses the canonical `{"type":"result"}` event from claude's stream-json output.
- **`opencode`** — uses the [opencode](https://opencode.ai) CLI. Tool allowlists/denylists and `permission-mode` are silently ignored (opencode has no equivalent CLI flags); craftsperson definitions are inlined via the `OPENCODE_CONFIG_CONTENT` env var at invocation time, sourced from `~/.claude/agents/<name>.md` bodies. Final result text is extracted by calling `opencode export <sessionID>` after the run completes.
- **`codex`** — uses the Codex CLI via `codex exec --json`. Hopper writes Codex's JSONL event stream to the audit file and captures the canonical final result with `--output-last-message`. Codex has no native craftsperson flag, so Hopper prepends the selected craftsperson body to the prompt; tool allowlists/denylists are enforced by Hopper's worker PATH shims rather than Codex CLI flags.

Hopper addresses models through a vendor-agnostic three-tier vocabulary — `deep`, `balanced`, `fast` — chosen per phase in `src/task-type-workflow.ts`. Each runner translates:

- claude → `deep|balanced|fast` map to its native `opus|sonnet|haiku` aliases (hard-coded in `src/gateways/model-tier.ts`).
- opencode → tiers resolve through `~/.hopper/runner-config.json` to whatever provider/model you've bound.
- codex → tiers resolve through the selected Hopper profile and are passed to `codex exec --model`.

To use the opencode runner, create `~/.hopper/runner-config.json`:

```json
{
  "opencode": {
    "models": {
      "deep":     "openai/gpt-5.5",
      "balanced": "openai/gpt-5.4",
      "fast":     "openai/gpt-5.4-mini"
    }
  }
}
```

Tier names not in the map (or any value containing `/`) are passed through to opencode unchanged, so you can mix tier names with native `provider/model` IDs in any `SessionOptions.model` field.

> Upgrading from hopper 2.x? The runner-config keys were `opus`/`sonnet`/`haiku` before 3.0 and now follow the tier vocabulary above. See [`docs/migration-2.x-to-3.x.md`](docs/migration-2.x-to-3.x.md) for the step-by-step rename and full migration notes.

`docs/opencode-spike.md` documents the empirical opencode CLI surface and the design decisions that shaped the runner.

## Agent Integration

Hopper is designed to be driven by AI agents. There are two roles:

### Coordinator

Breaks down work into discrete tasks and adds them to the queue. Run `hopper init` to install the coordinator skill for Claude Code globally, or `hopper init --local` inside a repo when you want a project-local install.

Task descriptions specify the work product and validation, not repository
lifecycle steps. Hopper owns sync, branch/worktree setup, staging, commit,
merge, push, and cleanup. Agent sessions are instructed to ignore conflicting
git clauses and git mutations are blocked across supported POSIX runners.

### Worker

Claims items, executes the described task, and reports back. The `hopper worker` command automates this loop:

1. Claims the next item via `hopper claim --json`
2. If the item has a `command` field, runs that shell command; otherwise runs an agent session with the task description and Hopper's git-ownership guardrails
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

MIT — see [LICENSE.md](LICENSE.md) for details.
