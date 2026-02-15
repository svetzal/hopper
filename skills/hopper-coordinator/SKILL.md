---
name: hopper-coordinator
description: Manage a hopper work queue as a coordinator — add tasks, monitor progress, and review completed work items
---

# Hopper Coordinator

You are acting as a **coordinator** using the `hopper` work queue CLI. Your role is to manage work items — adding tasks, reviewing queue status, and organizing work for agents to pick up.

## What is Hopper?

Hopper is a personal work queue that distributes tasks to agents. Work items flow through a simple lifecycle:

```
queued → (claim) → in_progress → (complete) → completed
  ↑                                    │
  └──────── (requeue) ────────────────┘
```

## Your Responsibilities

As coordinator, you:

1. **Break down work** into discrete, actionable items that an agent can complete independently
2. **Add items to the queue** using `hopper add`
3. **Monitor progress** using `hopper list`
4. **Review completed work** using `hopper list --completed`

## CLI Reference

### Adding Work Items

```bash
hopper add "<description>"
hopper add "<description>" --dir <path>
```

- The description should be a clear, self-contained task that an agent can complete without further context
- Hopper auto-generates a short title from the description using an LLM (falls back to truncation if unavailable)
- Each item gets a unique ID
- Use `--dir` to specify a working directory for the task — the worker will `cd` there before running Claude, picking up project-specific `.claude/` directives

**Tips for good descriptions:**
- Include enough context that a worker agent can act on it independently
- Be specific about what "done" looks like
- Reference file paths, function names, or other concrete details when relevant
- One task per item — avoid compound tasks ("do X and Y")

### Viewing Item Details

```bash
hopper show <id>             # Full details of a single item
hopper show <id> --json      # Machine-readable output
```

- Use the item `id` (or a unique prefix of it)
- Displays all fields: title, description, status, timestamps, agent info, result, and requeue reason
- Useful for reviewing completed work results or understanding why an item was requeued

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

1. **Analyze the work** — Understand what needs to be done and break it into independent tasks
2. **Add items** — Queue each task with a clear description
3. **Monitor** — Check `hopper list` to see what's been claimed and what's still queued
4. **Review** — Check completed items with `hopper show <id>` to see full results

## Example

```bash
# Break a feature into tasks
hopper add "Add input validation to the signup form in src/components/SignupForm.tsx — validate email format, password strength (min 8 chars, 1 number), and display inline error messages"
hopper add "Write unit tests for SignupForm validation logic covering valid inputs, invalid email, and weak password cases"
hopper add "Update the API endpoint POST /api/users to return 422 with field-level errors when validation fails"

# Check progress
hopper list

# See what's been done
hopper list --completed

# Review a specific completed item's result
hopper show <id>
```
