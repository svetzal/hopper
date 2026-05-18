# Migrating from hopper 2.x to 3.x

Hopper 3.0.0 introduces a second agent runner (opencode), a vendor-agnostic
model tier vocabulary, and per-phase reasoning effort. Two changes break
backwards compatibility — both small, both mechanical to fix.

For the full list of additions and internal refactors, see the
[3.0.0 entry in CHANGELOG.md](https://github.com/svetzal/hopper/blob/main/CHANGELOG.md#300---2026-05-18).

## TL;DR

If you've never touched `~/.hopper/runner-config.json` and you don't have
custom code that constructs `SessionOptions` directly, **upgrading is a
no-op**. Default workflows (`hopper add` / `hopper worker` with the claude
runner) behave identically to 2.x.

If either of those applies to you, two small renames are all that's needed:

| Where | 2.x | 3.x |
|---|---|---|
| `~/.hopper/runner-config.json` map keys | `opus`, `sonnet`, `haiku` | `deep`, `balanced`, `fast` |
| `SessionOptions.model` (in custom code) | `"opus"`, `"sonnet"`, `"haiku"` | `"deep"`, `"balanced"`, `"fast"` |

## Breaking change 1 — `~/.hopper/runner-config.json` keys

This file (only relevant if you use `--runner opencode`) used to key its
opencode model map by the Anthropic-flavoured aliases `opus`/`sonnet`/`haiku`.
Hopper 3.x addresses models through a vendor-agnostic tier vocabulary —
`deep`/`balanced`/`fast` — so the runner-config keys had to follow.

**Before (2.x):**

```json
{
  "opencode": {
    "models": {
      "opus":   "openai/gpt-5.5",
      "sonnet": "openai/gpt-5.4",
      "haiku":  "openai/gpt-5.4-mini"
    }
  }
}
```

**After (3.x):**

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

Only the keys change. The right-hand-side identifiers (provider/model) are
unchanged.

### Migration

```bash
# Back up first.
cp ~/.hopper/runner-config.json ~/.hopper/runner-config.json.bak

# Then rename the three keys. If you've added other tier aliases beyond
# the canonical three (e.g. literal `"gpt-5.5": "openai/gpt-5.5"` as an
# explicit-override entry), leave those untouched.
```

If you forget, opencode will receive the unmapped string verbatim and fail
with `Provider not found: opus` (or similar). It's loud — no silent
behaviour change.

## Breaking change 2 — `SessionOptions.model` vocabulary

Only relevant if you have **custom code** that constructs `SessionOptions`
directly — typically a bespoke worker integration or extension. The
built-in `hopper worker`, `hopper add`, audit viewer, and all CLI flows do
not need changes.

**Before (2.x):**

```ts
const opts: SessionOptions = {
  model: "opus",
  permissionMode: "plan",
};
```

**After (3.x):**

```ts
const opts: SessionOptions = {
  model: "deep",
  permissionMode: "plan",
};
```

### Per-runner translation behaviour

- **claude runner**: tier names map through a hard-coded table in
  `src/gateways/model-tier.ts` (`deep`→`opus`, `balanced`→`sonnet`,
  `fast`→`haiku`). The legacy alias strings (`"opus"`, `"sonnet"`,
  `"haiku"`) still pass through verbatim to the `claude` CLI, which
  accepts them natively — so on the claude runner the 2.x code keeps
  working. You only need to update if you also intend to run the same
  options through the opencode runner.
- **opencode runner**: tier names resolve through
  `~/.hopper/runner-config.json`. The legacy alias strings (`"opus"`,
  etc.) no longer translate — they will be forwarded to opencode as-is
  and fail with a "Provider not found" error.

### Runner-native escape hatch (unchanged)

Both runners still pass through anything that looks like a native
identifier (contains `/`, or is a known vendor alias). So you can mix
freely:

```ts
{ model: "deep" }                        // tier → runner-native
{ model: "openai/gpt-5.3-codex" }        // explicit provider/model
{ model: "claude-opus-4-7" }             // explicit claude model name
```

## New optional features in 3.x

These are additive — no migration required to keep using hopper as before,
but worth knowing they exist.

### `--runner opencode`

`hopper worker --runner opencode` dispatches session work through the
[opencode](https://opencode.ai) CLI instead of Claude Code. Fast-tier
one-shots (branch slug, commit message, validate-marker fallback) continue
running on Claude Code regardless. Requires opencode v1.15+ on `PATH` and
the model-binding entries described above. See `README.md` and
[`docs/opencode-spike.md`](opencode-spike.md) for the full design.

### Per-phase reasoning effort

`SessionOptions.effort` accepts `"minimal" | "low" | "medium" | "high" |
"max"` and is forwarded as `--effort` (claude) or `--variant` (opencode).
The built-in task-type workflows set sensible defaults
(plan/validate/investigation = `high`, execute = `medium`); pass an
`effort` field on a custom `SessionOptions` to override.

### Vendor-honest worker log lines

Worker phase log lines now use tier names (`Plan phase (deep, …)`,
`Execute phase attempt 1/2 (balanced, …)`) rather than vendor aliases.
Under `--runner opencode` this prevents the log from claiming a session is
running on opus when it's actually on `openai/gpt-5.5`.

## Rolling back

If something goes wrong and you need to drop back to 2.1.4 temporarily:

```bash
brew install hopper@2.1.4   # if available via tap, else build from tag
# or, working from the source repo:
cd ~/Work/Projects/Mojility/hopper
git checkout v2.1.4
bun run build
cp build/hopper ~/.local/bin/hopper
codesign --force --sign - ~/.local/bin/hopper
```

Restore your runner-config.json backup if you'd renamed the keys:

```bash
cp ~/.hopper/runner-config.json.bak ~/.hopper/runner-config.json
```

Queue state (`~/.hopper/items.json`) and audit history are
forward-and-backward compatible across 2.x and 3.x — neither schema
changed in this release. Worktree state likewise.

## Bug-fix worth noting

3.0.0 also fixes a bug that affected from-scratch project generation in
2.x: the engineering commit-message step sometimes received an empty diff
(because `git diff HEAD` excludes untracked files) and Haiku responded
with a meta-complaint that became the commit message. If you've seen
commits with messages like *"I don't see a diff summary in your message
— the 'Diff summary:' section is empty…"*, that's the same bug. It's
fixed in 3.0.0 with no migration needed.
