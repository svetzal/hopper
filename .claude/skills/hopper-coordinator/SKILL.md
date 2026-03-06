---
name: hopper-coordinator
description: Dispatch concrete, ready-to-execute work to background Claude Code agents via the hopper queue. Use this skill when the user wants to queue up substantive coding tasks for unattended processing in specific projects on their machine — not for planning, to-do tracking, or lightweight tasks.
---

# Hopper Coordinator

You are acting as a **coordinator** using the `hopper` work queue CLI. Your role is to dispatch concrete work items to a queue where autonomous Claude Code agents will pick them up and execute them unattended in the background.

## What is Hopper?

Hopper is a personal work dispatch system. You queue up substantive coding work, and background Claude Code worker agents claim and execute it autonomously — no human in the loop during execution. Work items flow through:

```
queued -> (claim) -> in_progress -> (complete) -> completed
  ^                                     |
  +------------ (requeue) -------------+
```

Each item consumes a full Claude Code session, so items should represent meaningful, well-defined work — not quick fixes or vague ideas.

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
3. **Monitor progress** using `hopper list`
4. **Review completed work** using `hopper show`

## CLI Reference

### Adding Work Items

```bash
hopper add "<description>" --dir <project-path> --branch <branch-name>
```

- `--dir` specifies the project directory on the host machine
- `--branch` specifies the git branch for the work (required with `--dir`)
- Workers create an isolated git worktree on that branch, so work never interferes with whatever is checked out in the main repo
- Hopper auto-generates a short title from the description using an LLM

Without `--dir` and `--branch`, items have no project context and workers won't know where to operate. Always specify these unless the item is for a project that doesn't use git.

**Writing good descriptions:**

Since an autonomous agent will execute this work with no human oversight, descriptions must be thorough:

- Include enough context that a worker agent can act without asking questions
- Be specific about what "done" looks like — expected behavior, files to create or modify, tests to pass
- Reference file paths, function names, or other concrete details
- One piece of work per item — avoid compound tasks

### Viewing Item Details

```bash
hopper show <id>             # Full details of a single item
hopper show <id> --json      # Machine-readable output
```

- Use the item `id` (or a unique prefix of it)
- Shows all fields including description, status, timestamps, agent info, result, and requeue reason
- Useful for reviewing completed work or understanding why an item was requeued

### Listing Items

```bash
hopper list                  # Show queued + in-progress items
hopper list --all            # Include completed items
hopper list --completed      # Show only completed items
hopper list --json           # Machine-readable output
```

### Machine-Readable Output

All commands support `--json` for structured output. Use this when you need to parse results programmatically.

## Workflow

1. **Validate** — Confirm the work is concrete, specific, and ready for autonomous execution
2. **Add items** — Queue each piece of work with a clear description, project directory, and branch
3. **Monitor** — Check `hopper list` to see what's been claimed and what's still queued
4. **Review** — Check completed items with `hopper show <id>` to see the agent's results

## Example

```bash
# Queue concrete work targeting specific projects
hopper add "Add input validation to the signup form in src/components/SignupForm.tsx — validate email format, password strength (min 8 chars, 1 number), and display inline error messages. Add unit tests in src/components/SignupForm.test.tsx covering valid inputs, invalid email, and weak password cases." \
  --dir ~/Work/Projects/webapp \
  --branch feat/signup-validation

hopper add "Migrate the user table to add a 'preferences' JSONB column with a default empty object. Update the User model in src/models/user.ts and add a migration file in src/migrations/. Run existing tests to confirm nothing breaks." \
  --dir ~/Work/Projects/api-server \
  --branch feat/user-preferences

# Check progress
hopper list

# Review a completed item
hopper show <id>
```
