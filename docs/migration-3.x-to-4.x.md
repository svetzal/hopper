# Migrating from hopper 3.x to 4.x

Hopper 4.0 is a **CLI-UX release**. The command surface was migrated to
`commander` and audited against the [CLI-UX
principles](https://github.com/svetzal/guidelines); most changes are additive
improvements (per-command help, unknown-flag rejection, command suggestions),
but three commands change in ways that affect existing muscle memory and
scripts.

For the full list of changes, see the
[4.0.0 entry in CHANGELOG.md](https://github.com/svetzal/hopper/blob/main/CHANGELOG.md#400---2026-07-06).

## TL;DR — breaking changes

- **`hopper reprioritize <id> <level>` is gone.** Use
  `hopper edit <id> --priority <level>`.
- **`hopper integrate <id>` now only *previews*.** It prints the git commands it
  would run and makes no changes. Add `--apply` to actually merge.
- **`hopper cancel` of an in-progress engineering item now asks first.** It
  force-deletes unmerged work, so it prompts for confirmation — and requires
  `--yes` when run non-interactively (agents, workers, CI).

Nothing else in your workflow changes. Queued/scheduled/blocked cancels, `add`,
`list`, `claim`, `complete`, `requeue`, `tag`/`untag`, `preset`, `profiles`, and
`worker` behave exactly as before.

## `reprioritize` → `edit`

`reprioritize` was a one-off verb outside hopper's shared vocabulary. It is
renamed to `edit`, with the priority passed as a flag:

```bash
# Before (3.x)
hopper reprioritize a1b2c3d4 high

# After (4.x)
hopper edit a1b2c3d4 --priority high
```

There is **no back-compat alias** — `hopper reprioritize` now reports an unknown
command. Update any scripts or notes that call it.

## `integrate` is safe by default

Previously `hopper integrate <id>` merged the item's branch into `main` and
force-deleted the branch immediately, with `--dry-run` as the opt-in preview.
That is inverted in 4.0: **preview is the default, execution is opt-in.**

```bash
# Preview — prints the git commands, makes NO changes
hopper integrate a1b2c3d4

# Execute the merge and clean up (what plain `integrate` used to do)
hopper integrate a1b2c3d4 --apply

# Execute but keep the worktree/branch
hopper integrate a1b2c3d4 --apply --keep-worktree
```

`--dry-run` is still accepted as a no-op alias for the (now default) preview, so
existing invocations that used it keep working. The one thing you must change:
**any workflow that relied on bare `integrate` to perform the merge now needs
`--apply`.**

## `cancel` confirms before discarding unmerged work

Cancelling a QUEUED, SCHEDULED, or BLOCKED item destroys nothing and is
unchanged — no prompt. But cancelling an **in-progress engineering** item tears
down its worktree and force-deletes its unmerged work branch (commits are lost).
In 4.0 that path asks first:

```bash
# Interactive: prompts "…commits will be lost. [y/N]"
hopper cancel a1b2c3d4

# Non-interactive (agent/worker/CI): must pass --yes, or the cancel aborts
hopper cancel a1b2c3d4 --yes
```

When stdin is not a TTY and `--yes` is absent, the cancel **aborts and leaves
the item untouched** rather than silently destroying work. Update any automation
that cancels in-progress engineering items to pass `--yes`.

## Also new (non-breaking)

- **Per-command help** — `hopper <command> --help` is now specific to that
  command instead of printing the whole usage wall.
- **Unknown flags are rejected** — a mistyped flag now errors instead of being
  silently ignored.
- **Command suggestions** — `hopper integrte` suggests `integrate`.
- **`[mutates]` markers** in help mark which commands change state.
- **Errors suggest the fix** — validation errors like the `--dir`/`--branch`
  pairing now append a runnable `Try: hopper add …` example.
