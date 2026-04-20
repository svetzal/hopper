---
name: hopper-coordinator
description: Dispatch concrete, ready-to-execute work to background Claude Code agents via the hopper queue. Use this skill when the user wants to queue up substantive coding tasks for unattended processing in specific projects on their machine — not for planning, to-do tracking, or lightweight tasks.
metadata:
  version: "2.0.7"
  author: Stacey Vetzal
---

# Hopper Coordinator

You are acting as a **coordinator** using the `hopper` work queue CLI. Your role is to dispatch concrete work items to a queue where autonomous Claude Code agents will pick them up and execute them unattended in the background.

## What is Hopper?

Hopper is a personal work dispatch system. You queue up substantive coding work (or arbitrary shell commands), and background worker agents claim and execute it autonomously — no human in the loop during execution. Work items flow through:

```
queued -----> (claim) --> in_progress --> (complete) --> completed
  ^                           |                            |
  +-------- (requeue) -------+                            |
                                                           |
blocked ----> (auto-unblock when dependencies complete) -> queued
scheduled --> (time arrives) -----------------------------> queued
cancelled (terminal)

Recurring items: completed --> new scheduled copy created automatically
```

Items without a `--command` flag consume a full Claude Code session, so those should represent meaningful, well-defined work — not quick fixes or vague ideas. Items with `--command` run a shell command instead and are useful for automated maintenance, builds, or any scriptable task.

Workers follow an **analyze → plan → execute → validate** cycle. Descriptions that include explicit validation criteria help workers verify their own work before finishing.

### Item Statuses

| Status | Meaning |
|--------|---------|
| `queued` | Ready for a worker to claim |
| `in_progress` | Claimed by a worker agent |
| `completed` | Work finished successfully |
| `cancelled` | Removed from the queue |
| `scheduled` | Deferred until a future time |
| `blocked` | Waiting on other items to complete first |

## When to Use Hopper

Hopper is the right tool when:

- The work is **concrete and fully specified** — an agent can start immediately without asking clarifying questions
- The work targets a **specific project** on the host machine
- The work is **substantive enough** to justify an autonomous agent session (refactoring, feature implementation, test suites, migrations, etc.)
- The user wants work done **in the background** while they continue doing other things

## When NOT to Use Hopper

Do not queue items that are:

- **Vague or exploratory** — "improve the codebase" or "look into performance issues" are not actionable
- **Planning or decomposition** — hopper is not a task tracker or to-do list; work should already be broken down before it reaches hopper
- **Trivial** — a one-line fix or simple rename doesn't warrant an autonomous agent session
- **Dependent on human input** — if the work requires decisions or clarification mid-stream, it's not ready for hopper

If the user asks you to queue something vague, help them refine it into concrete work first, or push back if it's not a good fit for background processing.

## Your Responsibilities

As coordinator, you:

1. **Validate that work is ready** — each item should be concrete, specific, and immediately actionable
2. **Add items to the queue** using `hopper add` with a project directory and branch
3. **Organize work** using priorities, tags, dependencies, and scheduling
4. **Monitor progress** using `hopper list` with appropriate filters
5. **Review completed work** using `hopper show`
6. **Manage the queue** — cancel, requeue, reprioritize, and tag items as needed

## CLI Reference

### ID Prefix Matching

All commands that accept an item `<id>` support prefix matching — you can use the first 8 characters (or any unique prefix) instead of the full UUID. If the prefix is ambiguous, hopper returns an error.

### Adding Work Items

```bash
hopper add "<description>" --dir <project-path> --branch <branch-name>
```

Every successful `hopper add` mutates the queue before printing confirmation. If a batch of adds appears to fail (e.g. a shell pipe errored, your terminal scrolled past output, a network blip killed the confirmation), check `hopper list` before retrying — items may already exist. `hopper add` is not idempotent; re-running produces duplicates.

**Flags:**

| Flag | Description |
|------|-------------|
| `--dir <path>` | Working directory for the task (requires `--branch` unless `--command` is set, or `--type investigation`) |
| `--branch <name>` | Git branch for the work (required with `--dir` unless `--command` is set; not allowed with `--type investigation`) |
| `--command <cmd>` | Shell command to run instead of Claude. Worker runs this command directly via `sh -c` |
| `--type <type>` | Task type: `task` (default), `engineering` (phased: plan→execute→validate), `investigation` (read-only, markdown deliverable) |
| `--agent <name>` | Force a specific craftsperson agent. For `--type engineering`, overrides auto-resolution; ignored for other types |
| `--retries <n>` | Engineering-only: max execute→validate remediation attempts after an initial validate FAIL. Default 1, max 5, `0` disables remediation |
| `--priority <level>` / `-p` | Set priority: `high`, `normal` (default), `low` |
| `--tag <tag>` | Add a tag (repeatable: `--tag api --tag backend`) |
| `--after <timespec>` | Schedule for later (e.g., `1h`, `30m`, `tomorrow 9am`) |
| `--every <duration>` | Make recurring (e.g., `4h`, `1d`). Minimum 5 minutes |
| `--times <n>` | Limit recurrences to n total runs (requires `--every`) |
| `--until <timespec>` | End date for recurrence (requires `--every`) |
| `--after-item <id>` | Block on another item (repeatable for multiple dependencies) |
| `--preset <name>` | Create from a saved preset template |
| `--json` | Machine-readable output |

**Notes:**
- For Claude items, `--dir` and `--branch` give workers the project context they need. Without them, workers won't know where to operate. Always specify these unless the item is for a project that doesn't use git
- Workers create an isolated git worktree on the specified branch, so work never interferes with whatever is checked out in the main repo
- For `--command` items, `--dir` alone is sufficient (no `--branch` required) — the command runs in the specified directory. If both `--dir` and `--branch` are set, a worktree is created and the command runs inside it
- Hopper auto-generates a short title from the description using an LLM
- `--after-item` creates a BLOCKED item that automatically moves to QUEUED when all dependencies complete. Circular dependencies are detected and rejected
- `--after` creates a SCHEDULED item. `--every` creates a recurring item that re-schedules itself after each completion. `--times` limits how many times it recurs
- `--depends-on` is an alias for `--after-item`

**Writing good descriptions:**

Since an autonomous agent will execute this work with no human oversight, descriptions must be thorough:

- Include enough context that a worker agent can act without asking questions
- Be specific about what "done" looks like — expected behavior, files to create or modify, tests to pass
- Reference file paths, function names, or other concrete details
- One piece of work per item — avoid compound tasks
- Always include validation criteria — specify which commands must pass (test, lint, type-check, build) and any project-specific checks. Workers validate their work automatically, but explicit steps in the description make expectations unambiguous

**Recommended description structure:**

1. **Context** — what exists today and why the change is needed
2. **Work** — what specifically to do, with file paths and concrete details
3. **Validation** — what commands must pass and what success looks like (e.g., "Run `bun test` and `bun run lint` — both must pass with zero errors")

**Choosing a task type:**

Hopper supports three task types, selected with `--type`:

| `--type` | Use when | Deliverable | Branch / merge |
|----------|----------|-------------|----------------|
| `task` (default) | Standard coding work that fits in one Claude session | Merged commit on target branch | Worktree → commit → merge → push |
| `engineering` | Work that benefits from explicit plan / execute / validate phases and a craftsperson agent | Merged commit on target branch, only after validate passes | `hopper-eng/<slug>-<prefix>` worktree → plan → execute → validate → commit → merge → push |
| `investigation` | Open-ended questions where the deliverable is a written finding, not code | Markdown findings report stored as the item's `result` | No branch, no worktree — runs read-only in `--dir` |

Quick decision:
- **Changing code** with a clear target branch → `task` or `engineering`. Use `engineering` when the work is substantial enough that plan→execute→validate genuinely pays off (complex refactors, non-trivial feature work, or when you want the extra safety of a dedicated validate phase). Use the default `task` for single-session work.
- **Answering a question** with no code changes → `investigation`. Hopper won't create a worktree or branch; the agent runs with read-only tools and its final message becomes the `result`.

**Engineering type specifics:**

Engineering items run a multi-phase workflow with model assignments tuned per phase:

1. **Plan** (opus, plan-mode, read-only tools) — emits a plan covering approach, files to touch, risks, and validation commands. Persisted to `~/.hopper/audit/<id>-plan.md` — never in the worktree.
2. **Execute** (sonnet, with the resolved craftsperson agent, git mutations denied) — follows the plan and makes code changes.
3. **Validate** (opus, read-only git, test/lint tools allowed) — runs the plan's validation commands, inspects the diff, emits `VALIDATE: PASS` or `VALIDATE: FAIL`.

Hopper owns every git operation. The agent never commits, branches, or pushes — if validate passes, Hopper generates a commit message via Haiku from the diff summary and runs the commit / merge / push itself.

**Remediation retries.** When validate reports `VALIDATE: FAIL`, Hopper loops back into execute with the prior execute summary and the validate failure inlined in the prompt, so the agent can target the regression rather than redoing working code. The cap is `--retries <n>` (default 1, max 5). `--retries 0` disables remediation — a first-pass validate FAIL terminates immediately with the worktree preserved. Each retry gets its own audit files: `<id>-execute-2.jsonl`, `<id>-validate-2.jsonl`, and so on; the first attempt keeps the legacy names (`<id>-execute.jsonl`, `<id>-validate.jsonl`).

Per-phase audit files land under `~/.hopper/audit/<id>-{plan,execute,validate}.jsonl` alongside the usual `-result.md`. `hopper show <id>` renders a `Phases:` strip showing each attempt, e.g. `plan ✓ 34s / execute ✓ 2m11s / validate ✗ FAIL / execute ✓ 45s / validate ✓ 20s`.

**Craftsperson agent auto-resolution:**

When you add an engineering item with `--dir` but no `--agent`, Hopper probes the project for stack markers (`package.json`, `Cargo.toml`, `pyproject.toml`, etc.) and asks Haiku to pick the best-fitting craftsperson from `~/.claude/agents/` and `<project>/.claude/agents/`. The resolved name is stored on the item and visible in `hopper show`.

Override the auto-pick with `--agent <name>` when you want a specific craftsperson. Pass `--agent` on a non-engineering item is a no-op — only the engineering execute phase consults it.

If no craftsperson fits well, Hopper leaves `agent` unset and the execute phase runs with Claude's default — better no agent than a wrong one.

**When to still hint a craftsperson in the description:**

For `task`-type items the old guidance still applies: if the work maps cleanly to a craftsperson subagent (e.g. `uv-python-craftsperson` for a `uv`-managed Python project, `typescript-bun-cli-craftsperson` for a Bun CLI), include an instruction in the description telling the worker to use it. Engineering items resolve this automatically; `task` items don't.

Do NOT force a craftsperson when none fits. Investigation items, shell-command items (`--command`), cross-cutting operational work, and tasks that don't match any available craftsperson should omit this entirely. A bad fit is worse than none.

### Listing Items

```bash
hopper list                      # Queued + in-progress + scheduled + blocked
hopper list --all                # Include completed and cancelled
hopper list --completed          # Only completed items
hopper list --scheduled          # Only scheduled items
hopper list --tag <tag>          # Filter by tag (repeatable, OR logic)
hopper list --priority <level>   # Filter by priority
hopper list --json               # Machine-readable output
```

Items are sorted by priority (high > normal > low), then by creation date (oldest first).

### Viewing Item Details

```bash
hopper show <id>             # Full details of a single item
hopper show <id> --json      # Machine-readable output
```

Shows all fields: description, status, timestamps, agent info, result, tags, dependencies, requeue reason, recurrence, and working directory.

### Investigating In-Progress Tasks

When an item has been in-progress suspiciously long (or a user asks "how is task X doing?"), don't guess. Check the audit log *first*. Only then look at processes. An IN_PROGRESS status in `hopper show` does not tell you whether the worker is actively making progress — the audit log does.

**How audit streaming works:**

Hopper streams each JSONL line from the claude subprocess to the audit file immediately as it arrives — events appear on disk within seconds of being emitted, not at session end. This means you can watch the file grow in real time as a liveness signal.

However, the audit file only reflects what the claude CLI itself has emitted. If Claude is thinking, waiting for a tool response, or processing a large response from a subagent, it may not emit events for minutes at a time even when healthy. Silence in the audit file during these periods is **not** proof of a hang — it is normal behavior. A genuine hang produces no new events for a sustained period (e.g., 10–15+ minutes) combined with a process in an unexpected state.

**Monitoring background work.** When watching a long-running background process or tailing a log, use the `Monitor` tool (streams each new stdout line as a notification) instead of polling with `pgrep -f X` + `tail /tmp/<log>`. Monitor lets you continue other work and get pinged when output appears — no repeated status checks burning context.

**Key files per task:**

| Path | Contents |
|------|----------|
| `~/.hopper/audit/<full-id>-audit.jsonl` | Every Claude session event: tool calls, thinking, user/assistant turns, hook runs. Events appear on disk as they stream from Claude — this is the primary liveness signal. |
| `~/.hopper/audit/<full-id>-result.md` | Final result written by the worker on completion. Present even if session ended early — may say "see audit log for details". |
| `~/.hopper/worktrees/<full-id>/` | Git worktree the worker operated in. Useful for finding partial changes. |
| `~/.hopper/items.json` | Full queue state, one JSON array at top level (NOT `.items[]`). Query with `jq '.[] | select(.id | startswith("<prefix>"))'`. |

**Step 1 — count audit events and skim the shape.**

```bash
wc -l ~/.hopper/audit/<full-id>-audit.jsonl        # How much work was logged
grep -o '"name":"[^"]*"' ~/.hopper/audit/<full-id>-audit.jsonl \
  | sort | uniq -c | sort -rn | head -20            # Tool-use histogram
grep -o '"command":"[^"]*"' ~/.hopper/audit/<full-id>-audit.jsonl \
  | tail -10                                        # Last shell commands attempted
```

A session with zero audit events (or an audit file that has not grown in 10–15+ minutes) hung before doing real work, or is stuck between events in Claude's internal processing. A session with hundreds of events then silence usually hit a runaway tool output, a stuck subagent, or an oversized response mid-stream.

**Step 2 — decode the tail in context.**

For readable summaries of the last N events, parse with Python to pull `role`, `tool_use` names, and `command`/`file_path` from the `input` object. One-liner sketch:

```python
import json
events = [json.loads(l) for l in open(p)]
for e in events[-15:]:
    msg = e.get('message') or {}
    content = msg.get('content')
    # content is a list of blocks; first block may be thinking, tool_use, text, or tool_result
    # Each needs slightly different extraction — see examples below
```

What to look for in the tail:
- **A tool_use with no matching tool_result** — session died mid-call. The `input` of that tool tells you what it was attempting (often a huge command, a massive scan, or a subagent Task).
- **A `system` event of subtype `task_started` with no subsequent assistant turn** — an Agent (subagent) was launched and never returned. Common when a Task prompt was too loose or the subagent itself got stuck.
- **A final assistant `text` block saying "I need to..." followed by nothing** — the session was composing a plan and got cut off.

**Step 3 — process tree, but interpret carefully.**

```bash
pgrep -fl "hopper worker"                              # Worker processes
pgrep -P <worker-pid>                                   # Child Claude sessions (one per in-flight task)
ps -p <claude-pid> -o pid,ppid,etime,state,command     # Check state
pgrep -P <claude-pid>                                   # Children of the Claude process (MCP servers, Bash subprocesses)
```

**Do not over-interpret process state.** `S` and `S+` just mean "sleeping (foreground)" — this is the default state for almost any interactive process between ticks of work. It does NOT mean "hung". A normally-running Claude session looks exactly like a hung one in `ps`. **Always corroborate with the audit log before diagnosing a hang.** An active session writes new events every few seconds to minutes; a stuck session writes none for a long stretch despite elapsed runtime.

**Signals to look for and possible interpretations:**

These are possibilities to investigate, not rankings — I haven't measured how often each occurs. Let the evidence in the specific audit log guide diagnosis.

- **No audit file exists at all** — the Claude binary didn't get far enough to write anything. Check the `hopper worker` parent process's stdout/stderr for errors.
- **Audit file has only startup events** (`SessionStart`, `hook_response`, `init`) then silence — something blocked right after initialization. Could be a startup hook, an MCP server that couldn't complete its handshake, or the session failing to receive its first task prompt.
- **Audit log has substantive work then goes quiet** — look at the last tool_use. If the `input` contains a potentially large operation (full-table scan, unbounded Glob, long Read of a binary/huge file), the response may have stalled stream processing. If the last event is a `system` of subtype `task_started` with no follow-up, a subagent (Task tool) may be the thing that's hung rather than the outer session.
- **Orphaned MCP children (`npm exec`, `node`) with elapsed times matching the session** — the MCP servers are alive. Whether they're *the* blocker requires corroborating evidence in the audit log (e.g. a tool_use of an MCP tool with no tool_result). Killing MCP children without that evidence is speculative.

Don't pattern-match too aggressively. Read the specific audit log, note what it tells you, and say what you see — not what you'd guess is typical.

**Step 4 — report to the user with specifics, not guesses.**

When giving an update, include:
- Total audit events (a proxy for how much work the worker did)
- Tool-use distribution (shows what the worker focused on)
- Last 2-3 commands or operations from the tail
- Whether the expected output artifact (the file the description said to write) exists
- Your diagnosis of the likely hang point, grounded in the audit log

Avoid speculative MCP-hang narratives unless the audit log supports them. "Stuck" ≠ "stuck in MCP init".

**Step 5 — decide with the user before killing processes.**

Options when a task is genuinely stuck:
1. Kill the Claude session PID → worker notices and auto-marks the item. May leave it as in_progress until the next worker tick; follow up with `hopper requeue` if needed.
2. `hopper requeue <id> --reason "..."` → explicit requeue, worker claim is released, item re-enters the queue.
3. If the audit log shows near-complete investigation work, you may have enough intel to synthesize findings manually from the audit content instead of retrying — check with the user first.

### Cancelling Items

```bash
hopper cancel <id>
hopper cancel <id> --json
```

Cancels a QUEUED, SCHEDULED, or BLOCKED item. Cannot cancel items that are IN_PROGRESS or already COMPLETED. If other items depend on the cancelled item, they remain BLOCKED — consider cancelling or updating those too.

### Requeuing Items

```bash
hopper requeue <id> --reason "description of why"
hopper requeue <id> --reason "..." --agent <name> --json
```

Returns an IN_PROGRESS item back to QUEUED status. The `--reason` flag is required — it records why the work couldn't be completed. Only works on IN_PROGRESS items.

### Integrating Completed Work

```bash
hopper integrate <id>                   # Merge branch into main, remove worktree and branch
hopper integrate <id> --keep-worktree   # Merge but leave worktree and branch in place
hopper integrate <id> --dry-run         # Print the git commands that would run, exit 0
hopper integrate <id> --json            # Machine-readable output
```

Checks out `main` in the item's `workingDir`, merges the item's worker branch with `--no-edit`, then deletes the branch and worktree by default. Only works on `completed` or `in_progress` items that have a `workingDir` and `branch`. On merge conflict, hopper surfaces the git stderr and leaves the repository state intact for manual resolution.

### Reprioritizing Items

```bash
hopper reprioritize <id> high
hopper reprioritize <id> normal
hopper reprioritize <id> low
```

Changes the priority of a QUEUED or SCHEDULED item. Cannot reprioritize items that are IN_PROGRESS, COMPLETED, or CANCELLED.

### Tagging Items

```bash
hopper tag <id> <tag> [<tag>...]       # Add tags
hopper untag <id> <tag> [<tag>...]     # Remove tags
```

Tags are alphanumeric plus hyphens, auto-lowercased, deduplicated, and sorted. Use tags to categorize work and filter with `hopper list --tag`.

### Presets (Reusable Templates)

Presets save item templates for repetitive work patterns:

```bash
hopper preset add <name> "<description>" --dir <path> --branch <branch>
hopper preset add <name> "<description>" --command <cmd> --dir <path>
hopper preset list
hopper preset show <name>
hopper preset remove <name>
```

Use a preset when adding items:

```bash
hopper add --preset <name>                    # Use preset as-is
hopper add --preset <name> --tag urgent       # Override/add flags
hopper add "custom desc" --preset <name>      # Override description
```

Command-line flags and positional descriptions override preset values. Preset names must be alphanumeric plus hyphens. Use `--force` with `preset add` to overwrite an existing preset.

### Machine-Readable Output

All commands support `--json` for structured output. Use this when you need to parse results programmatically or chain commands together.

## Automatic Directory Serialization

Workers process multiple items concurrently (default concurrency: 4). The claim system **automatically serializes items that target the same or overlapping directories** — you do not need to chain them manually for conflict prevention.

When a worker claims an item, all other queued items whose `workingDir` overlaps with the claimed item's directory are skipped until that item completes. Overlap detection includes:

- **Exact match** — `/repo/project` and `/repo/project` serialize
- **Parent/child containment** — `/repo` and `/repo/project` serialize (work in a parent directory could affect a child, and vice versa)
- **No false positives** — `/repo/project1` and `/repo/project2` run in parallel (sibling directories are independent)

This means items targeting **different projects** run in parallel automatically, while items targeting the **same project** (regardless of branch) run one at a time.

### When you still need `--after-item`

Use `--after-item` for:

- **Logical dependencies** — item B needs item A's output (e.g., a migration must exist before the endpoint that uses it)
- **Explicit ordering** — you want items in the same directory to run in a specific sequence, not just one-at-a-time in priority/FIFO order

You no longer need `--after-item` purely to prevent concurrent execution conflicts in the same directory — that is handled automatically.

## Workflow

1. **Validate** — Confirm the work is concrete, specific, and ready for autonomous execution
2. **Organize** — Decide on priority, tags, scheduling, and dependencies
3. **Add items** — Queue each piece of work with a clear description, project directory, and branch. Use `--after-item` only for logical dependencies or explicit ordering
4. **Monitor** — Check `hopper list` to see what's been claimed, what's blocked, and what's still queued
5. **Adjust** — Reprioritize, tag, cancel, or requeue items as the situation evolves
6. **Review** — Check completed items with `hopper show <id>` to see the agent's results

### Batch Operations

When queueing N items in a loop, tag the batch with a unique identifier so you can verify the count before proceeding:

```bash
hopper add "..." --dir <path> --branch <branch> --tag batch-20260412-1
```

After the loop completes, confirm exactly N items landed:

```bash
hopper list --tag batch-20260412-1 --json | jq 'length'
```

If the count is higher than expected, duplicates were created — investigate before firing more commands. If lower, some adds failed silently.

## Examples

### Basic work dispatch

```bash
hopper add "Add input validation to the signup form in src/components/SignupForm.tsx — validate email format, password strength (min 8 chars, 1 number), and display inline error messages. Add unit tests in src/components/SignupForm.test.tsx covering valid inputs, invalid email, and weak password cases. Run the full test suite and linter before finishing — both must pass with zero errors." \
  --dir ~/Work/Projects/webapp \
  --branch feat/signup-validation

hopper add "Migrate the user table to add a 'preferences' JSONB column with a default empty object. Update the User model in src/models/user.ts and add a migration file in src/migrations/. Run existing tests and the type checker to confirm nothing breaks — zero failures required." \
  --dir ~/Work/Projects/api-server \
  --branch feat/user-preferences
```

### Prioritized and tagged work

```bash
hopper add "Fix the race condition in the WebSocket reconnection logic. Add a regression test that reproduces the race condition and verifies the fix. Run the full test suite and linter before finishing — both must pass." \
  --dir ~/Work/Projects/app \
  --branch fix/ws-reconnect \
  -p high \
  --tag backend --tag bugfix
```

### Same-directory work (automatic serialization)

```bash
# These two items target the same project — no chaining needed!
# The claim system automatically runs them one at a time.

hopper add "Add input validation to the signup form. Validate email format and password strength. Add unit tests. Run the test suite and linter — both must pass." \
  --dir ~/Work/Projects/webapp \
  --branch feat/form-improvements

hopper add "Add loading spinners to all form submit buttons. Run the test suite and linter — both must pass." \
  --dir ~/Work/Projects/webapp \
  --branch feat/form-improvements
```

### Logical dependency chain

```bash
# Use --after-item when order matters logically —
# the API endpoint needs the migration to exist first

hopper add "Add the orders table migration. Run existing tests and type checker to confirm nothing breaks." \
  --dir ~/Work/Projects/api \
  --branch feat/orders
# Output: Created item e5f6g7h8-...

hopper add "Implement GET /api/orders endpoint with pagination. Add integration tests. Run the full test suite and linter — both must pass." \
  --dir ~/Work/Projects/api \
  --branch feat/orders \
  --after-item e5f6g7h8
```

### Shell command items

```bash
# Run a build command in a specific directory
hopper add "Run production build" \
  --command "npm run build" \
  --dir ~/Work/Projects/webapp

# Shell command with worktree (runs command on a fresh branch)
hopper add "Run linter and auto-fix" \
  --command "npm run lint:fix" \
  --dir ~/Work/Projects/webapp \
  --branch chore/lint-fixes
```

### Hone maintenance and iteration via hopper

`hone maintain` and `hone iterate` are ideal candidates for `--command` items — they're
self-contained shell commands that update dependencies or improve code quality in a
specific project. By routing them through hopper you get scheduling, recurrence,
dependency chaining, and audit logging for free.

```bash
# One-off maintenance run
hopper add "Maintain hopper — update deps and verify gates" \
  --command "hone maintain typescript-bun-cli-craftsperson /Users/svetzal/Work/Projects/Mojility/hopper" \
  --dir ~/Work/Projects/Mojility/hopper

# One-off iterate (quality improvement cycle)
hopper add "Iterate on mojentic-py — assess, plan, execute, verify" \
  --command "hone iterate uv-python-craftsperson /Users/svetzal/Work/Projects/Mojility/mojentic" \
  --dir ~/Work/Projects/Mojility/mojentic

# Nightly recurring maintenance with a preset
hopper preset add maintain-hopper "Nightly dependency maintenance for hopper" \
  --command "hone maintain typescript-bun-cli-craftsperson /Users/svetzal/Work/Projects/Mojility/hopper" \
  --dir ~/Work/Projects/Mojility/hopper
hopper add --preset maintain-hopper --every 1d --tag maintenance

# Multiple projects run in parallel automatically (different dirs)
hopper add "Maintain hone-cli" \
  --command "hone maintain typescript-bun-cli-craftsperson /Users/svetzal/Work/Projects/Mojility/hone-cli" \
  --dir ~/Work/Projects/Mojility/hone-cli \
  --tag maintenance

hopper add "Maintain hopper" \
  --command "hone maintain typescript-bun-cli-craftsperson /Users/svetzal/Work/Projects/Mojility/hopper" \
  --dir ~/Work/Projects/Mojility/hopper \
  --tag maintenance
```

**Tips for hone items:**
- Use `--dir` so audit logs record which project the command targeted, but `--branch` is
  usually unnecessary — hone manages its own git operations internally
- Items targeting different directories run in parallel automatically — no chaining needed
- Items targeting the same directory are serialized automatically — no chaining needed
- Tag maintenance items consistently (e.g. `--tag maintenance`) for easy filtering
  with `hopper list --tag maintenance`

### Engineering-type work (phased, auto-picked craftsperson)

```bash
# Hopper auto-picks the craftsperson from project markers + installed agents
hopper add "Add a --quiet flag to the CLI that suppresses info-level output. \
  Update src/cli.ts to accept the flag and thread it through to the logger. \
  Add tests covering default and --quiet behaviours." \
  --type engineering \
  --dir ~/Work/Projects/Mojility/hopper \
  --branch feat/quiet-flag

# Force a specific craftsperson instead of auto-resolving
hopper add "Refactor the request router to use a trie." \
  --type engineering \
  --agent rust-craftsperson \
  --dir ~/Work/Projects/api \
  --branch refactor/router-trie

# Allow up to 3 remediation attempts on validate failure
hopper add "Migrate the payment service from Moment to Temporal. Update date \
  handling in src/payments.ts and all consumers; run tests and lint." \
  --type engineering \
  --dir ~/Work/Projects/api \
  --branch refactor/temporal \
  --retries 3

# Strict single-shot — no remediation on validate failure
hopper add "Bump lockfile and fix any resulting test breakage." \
  --type engineering \
  --dir ~/Work/Projects/api \
  --branch chore/lockfile-bump \
  --retries 0
```

Engineering items run plan → execute → validate; Hopper commits + merges only if validate reports `VALIDATE: PASS`. On failure the worktree + branch are preserved under `~/.hopper/worktrees/<id>` and `hopper-eng/<slug>-<prefix>` for inspection. Audit artefacts live at `~/.hopper/audit/<id>-{plan,execute,validate}.jsonl` plus `<id>-plan.md`.

### Investigation-type work (read-only, markdown deliverable)

```bash
hopper add "Find every place in src/ that calls setTimeout without a paired clearTimeout, \
  and summarise which look like real leaks vs. fire-and-forget timers." \
  --type investigation \
  --dir ~/Work/Projects/webapp
```

Investigation items never get a worktree or branch. The agent runs with read-only tools; its final markdown message becomes the item's `result` field, readable via `hopper show <id>`.

### Scheduled and recurring work

```bash
# Schedule for later
hopper add "Run the full integration test suite and fix any failures..." \
  --dir ~/Work/Projects/api \
  --branch chore/integration-tests \
  --after 2h

# Recurring daily task
hopper add "Check for outdated dependencies and update patch versions..." \
  --dir ~/Work/Projects/app \
  --branch chore/dep-updates \
  --every 1d

# Limited recurrence — run smoke tests 3 times, 10 minutes apart
hopper add "Run smoke tests" --command "npm test" --every 10m --times 3
```

### Monitoring and managing the queue

```bash
hopper list                        # What's active?
hopper list --tag backend          # Just backend work
hopper list --completed            # What finished?
hopper show a1b2c3d4               # Full details (prefix match)
hopper reprioritize a1b2c3d4 high  # Bump priority
hopper cancel e5f6g7h8             # Remove from queue
```
