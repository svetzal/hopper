---
name: hopper-coordinator
description: Dispatch concrete, ready-to-execute work to background Claude Code agents via the hopper queue. Use this skill when the user wants to queue up substantive coding tasks for unattended processing in specific projects on their machine — not for planning, to-do tracking, or lightweight tasks.
metadata:
  version: "1.4.1"
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

**Flags:**

| Flag | Description |
|------|-------------|
| `--dir <path>` | Working directory for the task (requires `--branch` unless `--command` is set) |
| `--branch <name>` | Git branch for the work (required with `--dir` unless `--command` is set) |
| `--command <cmd>` | Shell command to run instead of Claude. Worker runs this command directly via `sh -c` |
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

## Conflict-Aware Sequencing

Workers can process multiple queued items concurrently. Items targeting the same project and branch — or even different branches in the same repo — can cause git conflicts, merge failures, or lost work if they execute simultaneously. This is the most common source of hopper failures.

**Before adding items to the queue, pause and ask yourself: "Could any of these items conflict if a worker picks them up at the same time?"**

Two items conflict when any of these are true:
- They target the **same project directory and branch** (virtually guaranteed to conflict)
- They target the **same project directory on different branches** that touch overlapping files (worktree operations can still interfere)
- They modify **shared configuration files** (package.json, tsconfig, CI configs) even from different feature areas

When you identify items that could conflict, **chain them with `--after-item`** so they execute consecutively rather than concurrently. This isn't about logical dependency — item B doesn't need item A's output. It's about preventing simultaneous execution from causing merge conflicts or race conditions.

This applies even when the items are conceptually independent. Two unrelated bug fixes on the same branch are logically independent but operationally conflicting — they must run one after another.

### How to think about it

When queuing a single item, no sequencing is needed. When queuing multiple items, sort them into groups by project directory:

- **Different projects** — safe to run concurrently, no chaining needed
- **Same project, different branches, non-overlapping work** — usually safe, but consider chaining if both touch shared files
- **Same project and branch** — always chain with `--after-item`

When chaining, add the first item normally, capture its ID from the output, then pass it as `--after-item <id>` on the next item. For a chain of 3+, each item depends on the previous one.

## Workflow

1. **Validate** — Confirm the work is concrete, specific, and ready for autonomous execution
2. **Organize** — Decide on priority, tags, scheduling, and dependencies
3. **Check for conflicts** — Before adding anything, review the full set of items you plan to queue. Group by project directory and branch. Identify which items need `--after-item` chaining to prevent concurrent execution conflicts
4. **Add items** — Queue each piece of work with a clear description, project directory, and branch. Chain conflicting items with `--after-item`
5. **Monitor** — Check `hopper list` to see what's been claimed, what's blocked, and what's still queued
6. **Adjust** — Reprioritize, tag, cancel, or requeue items as the situation evolves
7. **Review** — Check completed items with `hopper show <id>` to see the agent's results

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

### Conflict-safe sequencing (same project/branch)

```bash
# These two items target the same project and branch — they MUST be chained
# even though they're conceptually independent work

# First item queues normally
hopper add "Add input validation to the signup form. Validate email format and password strength. Add unit tests. Run the test suite and linter — both must pass." \
  --dir ~/Work/Projects/webapp \
  --branch feat/form-improvements
# Output: Created item a1b2c3d4-...

# Second item chains off the first to prevent concurrent execution
hopper add "Add loading spinners to all form submit buttons. Run the test suite and linter — both must pass." \
  --dir ~/Work/Projects/webapp \
  --branch feat/form-improvements \
  --after-item a1b2c3d4
```

### Logical dependency chain

```bash
# Here the sequencing is both conflict-prevention AND logical —
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

# Chain multiple projects so they don't compete for resources
hopper add "Maintain hone-cli" \
  --command "hone maintain typescript-bun-cli-craftsperson /Users/svetzal/Work/Projects/Mojility/hone-cli" \
  --dir ~/Work/Projects/Mojility/hone-cli \
  --tag maintenance
# Output: Created item a1b2c3d4-...

hopper add "Maintain hopper" \
  --command "hone maintain typescript-bun-cli-craftsperson /Users/svetzal/Work/Projects/Mojility/hopper" \
  --dir ~/Work/Projects/Mojility/hopper \
  --tag maintenance \
  --after-item a1b2c3d4
```

**Tips for hone items:**
- Use `--dir` so audit logs record which project the command targeted, but `--branch` is
  usually unnecessary — hone manages its own git operations internally
- Chain items targeting the same machine with `--after-item` when running under
  `hopper worker --concurrency` to avoid resource contention
- Tag maintenance items consistently (e.g. `--tag maintenance`) for easy filtering
  with `hopper list --tag maintenance`

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
