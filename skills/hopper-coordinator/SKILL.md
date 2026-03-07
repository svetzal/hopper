---
name: hopper-coordinator
description: Dispatch concrete, ready-to-execute work to background Claude Code agents via the hopper queue. Use this skill when the user wants to queue up substantive coding tasks for unattended processing in specific projects on their machine — not for planning, to-do tracking, or lightweight tasks.
---

# Hopper Coordinator

You are acting as a **coordinator** using the `hopper` work queue CLI. Your role is to dispatch concrete work items to a queue where autonomous Claude Code agents will pick them up and execute them unattended in the background.

## What is Hopper?

Hopper is a personal work dispatch system. You queue up substantive coding work, and background Claude Code worker agents claim and execute it autonomously — no human in the loop during execution. Work items flow through:

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

Each item consumes a full Claude Code session, so items should represent meaningful, well-defined work — not quick fixes or vague ideas.

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
| `--dir <path>` | Working directory for the task (requires `--branch`) |
| `--branch <name>` | Git branch for the work (required with `--dir`) |
| `--priority <level>` / `-p` | Set priority: `high`, `normal` (default), `low` |
| `--tag <tag>` | Add a tag (repeatable: `--tag api --tag backend`) |
| `--after <timespec>` | Schedule for later (e.g., `1h`, `30m`, `tomorrow 9am`) |
| `--every <duration>` | Make recurring (e.g., `4h`, `1d`). Minimum 5 minutes |
| `--until <timespec>` | End date for recurrence (requires `--every`) |
| `--after-item <id>` | Block on another item (repeatable for multiple dependencies) |
| `--preset <name>` | Create from a saved preset template |
| `--json` | Machine-readable output |

**Notes:**
- `--dir` and `--branch` give workers the project context they need. Without them, workers won't know where to operate. Always specify these unless the item is for a project that doesn't use git
- Workers create an isolated git worktree on the specified branch, so work never interferes with whatever is checked out in the main repo
- Hopper auto-generates a short title from the description using an LLM
- `--after-item` creates a BLOCKED item that automatically moves to QUEUED when all dependencies complete. Circular dependencies are detected and rejected
- `--after` creates a SCHEDULED item. `--every` creates a recurring item that re-schedules itself after each completion
- `--depends-on` is an alias for `--after-item`

**Writing good descriptions:**

Since an autonomous agent will execute this work with no human oversight, descriptions must be thorough:

- Include enough context that a worker agent can act without asking questions
- Be specific about what "done" looks like — expected behavior, files to create or modify, tests to pass
- Reference file paths, function names, or other concrete details
- One piece of work per item — avoid compound tasks

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

## Workflow

1. **Validate** — Confirm the work is concrete, specific, and ready for autonomous execution
2. **Organize** — Decide on priority, tags, scheduling, and dependencies
3. **Add items** — Queue each piece of work with a clear description, project directory, and branch
4. **Monitor** — Check `hopper list` to see what's been claimed, what's blocked, and what's still queued
5. **Adjust** — Reprioritize, tag, cancel, or requeue items as the situation evolves
6. **Review** — Check completed items with `hopper show <id>` to see the agent's results

## Examples

### Basic work dispatch

```bash
hopper add "Add input validation to the signup form in src/components/SignupForm.tsx — validate email format, password strength (min 8 chars, 1 number), and display inline error messages. Add unit tests in src/components/SignupForm.test.tsx covering valid inputs, invalid email, and weak password cases." \
  --dir ~/Work/Projects/webapp \
  --branch feat/signup-validation

hopper add "Migrate the user table to add a 'preferences' JSONB column with a default empty object. Update the User model in src/models/user.ts and add a migration file in src/migrations/. Run existing tests to confirm nothing breaks." \
  --dir ~/Work/Projects/api-server \
  --branch feat/user-preferences
```

### Prioritized and tagged work

```bash
hopper add "Fix the race condition in the WebSocket reconnection logic..." \
  --dir ~/Work/Projects/app \
  --branch fix/ws-reconnect \
  -p high \
  --tag backend --tag bugfix
```

### Sequenced work with dependencies

```bash
# First: create the database migration
hopper add "Add the orders table migration..." \
  --dir ~/Work/Projects/api \
  --branch feat/orders

# Then: build the API endpoint (blocked until migration completes)
hopper add "Implement GET /api/orders endpoint..." \
  --dir ~/Work/Projects/api \
  --branch feat/orders \
  --after-item <migration-item-id>
```

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
