---
name: hopper-worker
description: Act as a hopper worker agent — claim work items from the queue, execute tasks, and report completion or requeue
---

# Hopper Worker

You are acting as a **worker agent** using the `hopper` work queue CLI. Your role is to claim work items from the queue, complete them, and report back.

## What is Hopper?

Hopper is a personal work queue that distributes tasks to agents. Work items flow through a simple lifecycle:

```
queued → (claim) → in_progress → (complete) → completed
  ↑                                    │
  └──────── (requeue) ────────────────┘
```

## Your Responsibilities

As a worker, you:

1. **Claim** the next available work item from the queue
2. **Execute** the task described in the work item
3. **Complete** the item when done, or **requeue** it if you cannot finish

## CLI Reference

### Claiming Work

```bash
hopper claim --agent "<your-name>" --json
```

- Claims the oldest queued item (FIFO order)
- Returns the item with `id`, `title`, `description`, `claimToken`, and optionally `workingDir`
- The `claimToken` is required to complete the item — save it
- If `workingDir` is set, switch to that directory before doing work so you pick up project-specific `.claude/` directives
- If no items are available, the command exits with status 1

### Completing Work

```bash
hopper complete "<claimToken>" --agent "<your-name>"
```

- Marks the claimed item as completed
- Requires the exact `claimToken` returned from the claim

### Requeuing Work

```bash
hopper requeue "<id>" --reason "<why>" --agent "<your-name>"
```

- Returns the item to the queue if you cannot complete it
- You must provide a reason explaining why the item is being requeued
- Use the item `id` (or a unique prefix of it), not the claim token

### Viewing Item Details

```bash
hopper show "<id>" --json       # Full details of a single item
```

- Use the item `id` (or a unique prefix of it)
- Shows all fields: title, full description, status, timestamps, agent info, result, and requeue reason
- Useful for understanding requeued items or reviewing prior work

### Checking the Queue

```bash
hopper list --json              # See queued + in-progress items
```

## Workflow

1. **Claim** — Run `hopper claim --agent "<name>" --json` to get your next task
2. **Parse** — Read the `title` and `description` to understand what needs to be done
3. **Execute** — Complete the task as described
4. **Report** — Run `hopper complete "<token>" --agent "<name>"` when done

If you encounter a problem that prevents completion:
- Run `hopper requeue "<id>" --reason "<explanation>" --agent "<name>"`
- Be specific in your reason so the coordinator or next worker understands what went wrong

## Example Session

```bash
# Claim next task
CLAIM=$(hopper claim --agent "worker-1" --json)
# Parse the response for title, description, claimToken, and id

# ... do the work described in the task ...

# Mark as done
hopper complete "<claimToken>" --agent "worker-1"
```

## Important Notes

- Always use `--json` when claiming so you can reliably parse the output
- Save the `claimToken` immediately — you need it to complete the item
- Save the `id` as well — you need it if you have to requeue
- One item at a time — finish or requeue before claiming another
- Be specific in requeue reasons — vague reasons like "couldn't do it" are unhelpful
