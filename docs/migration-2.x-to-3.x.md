# Migrating from hopper 2.x to 3.x

Hopper 3.0 reworks runner and model selection into per-job **profiles**,
removes the global `--runner` flag from the worker, and introduces
per-phase reasoning effort. The full feature surface — profiles, the four
shipped templates, on-disk shape — is covered in
[Profiles](/profiles); this guide focuses on what changes for someone
upgrading from 2.x.

For the full list of additions and internal refactors, see the
[3.0.0 entry in CHANGELOG.md](https://github.com/svetzal/hopper/blob/main/CHANGELOG.md#300---2026-05-18).

## TL;DR

- `~/.hopper/runner-config.json` is gone. Per-job **profiles** at
  `~/.hopper/profiles/<name>.json` replace it.
- `hopper worker --runner <name>` is gone. The worker is runner-agnostic
  and dispatches per item based on `item.profile`.
- `hopper add` takes a new `--profile <name>` flag; absent, it falls
  back to `defaultProfile` in `~/.hopper/config.json`.
- The first `hopper add` after upgrade **bootstraps** `~/.hopper/`
  automatically: writes `config.json` plus four shipped profile
  templates (`anthropic`, `openai`, `openrouter`, `ollama`).
- The default profile is **`openai`**, not `anthropic` — see
  [Profiles → Why `openai` is the default](/profiles#why-openai-is-the-default).
- Model tier vocabulary (`deep` / `balanced` / `fast`) is unchanged from
  the original 3.0 cut.

## For 2.x users with no `~/.hopper/runner-config.json`

**Upgrade is a no-op.** You never customised runner bindings in 2.x, so
there's nothing to migrate.

The first time you run `hopper add` after upgrading, hopper writes the
default config and the four shipped profile templates. Queued items use
the `openai` profile unless you pass `--profile <name>` or change
`defaultProfile` in `~/.hopper/config.json`.

If you want to keep using Claude Code with a direct Anthropic API key:

```bash
# One-time, per-job
hopper add "..." --profile anthropic

# Or change the default once
echo '{"defaultProfile": "anthropic"}' > ~/.hopper/config.json
```

That's the whole migration.

## For 2.x users who had a `~/.hopper/runner-config.json`

If you customised the 2.x opencode binding, port the model map into a
profile file.

A 2.x runner-config like this:

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

…becomes a profile file at `~/.hopper/profiles/openai.json`:

```json
{
  "runner": "opencode",
  "models": {
    "deep":     "openai/gpt-5.5",
    "balanced": "openai/gpt-5.4",
    "fast":     "openai/gpt-5.4-mini"
  }
}
```

Two changes:

- The wrapping `"opencode": { ... }` envelope is gone; `runner` is a
  top-level field naming `"opencode"` or `"claude"`.
- The model-map keys move from the Anthropic-flavoured aliases
  (`opus`/`sonnet`/`haiku`) to the canonical tier vocabulary
  (`deep`/`balanced`/`fast`). The right-hand-side identifiers don't
  change.

After porting, delete the old file:

```bash
rm ~/.hopper/runner-config.json
```

Then run `hopper profiles` to confirm hopper sees your new file:

```text
Default profile: openai

* openai  (opencode)
      deep:     openai/gpt-5.5
      balanced: openai/gpt-5.4
      fast:     openai/gpt-5.4-mini
  ...
```

> If you happened to install the originally-cut 3.0.0 (since deleted and
> re-pushed) and wrote a `runner-config.json` against it, the same
> procedure applies: delete the runner-config, let `hopper add` bootstrap
> the profiles directory on first invocation, then edit the shipped
> templates to taste. There is no in-place migration tool — by design.

## `--runner` flag removed

`hopper worker --runner opencode` no longer exists. The worker is
runner-agnostic: it inspects each item's `profile` field and dispatches
through whichever runner that profile names. A single worker can drain a
queue containing items dispatched to claude, opencode-against-OpenAI,
and opencode-against-ollama simultaneously.

If you still pass `--runner` (typically from an old shell alias or a
launchd plist), the worker exits with a clear message:

```text
--runner was removed in hopper 3.0.0; runner selection is now per-item
via profiles. Use `hopper add --profile <name>` to queue items against
a specific profile.
```

Remove the flag from your alias / launchd plist / Makefile and the
worker starts normally.

## `SessionOptions` API change

**Only relevant if you have custom code that constructs `SessionOptions`
directly** — typically a bespoke worker integration or extension. The
built-in `hopper worker`, `hopper add`, audit viewer, and all CLI flows
do not need changes.

`SessionOptions` (defined in `src/gateways/agent-runner.ts`) now carries
an optional `profile` field of type `Profile` from `src/profile.ts`. The
worker fills it from `item.profile` before each phase. Callers that
construct `SessionOptions` manually must supply a profile too — the
runner uses it to resolve model aliases against the profile's `models`
map.

Likewise, `AgentRunner.generateText` now takes a required `profile` on
its options object:

```ts
const result = await runner.generateText(prompt, "fast", {
  profile,         // required in 3.x
  cwd: workingDir,
});
```

This is the only SDK-level break in 3.0. In practice nearly no one calls
these gateways directly — they're internal.

## Per-phase reasoning effort

This is the same feature that landed in the original 3.0 cut, kept here
for completeness:

`SessionOptions.effort` accepts `"minimal" | "low" | "medium" | "high" |
"max"` and is forwarded as `--effort` (claude) or `--variant` (opencode).
The built-in task-type workflows set sensible defaults
(plan/validate/investigation = `high`, execute = `medium`); pass an
`effort` field on a custom `SessionOptions` to override.

Worker phase log lines name the tier rather than the vendor alias —
`Plan phase (deep, …)`, `Execute phase attempt 1/2 (balanced, …)` —
so a run on `openai/gpt-5.5` no longer pretends to be running on `opus`.

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

To resume using 2.x against your old configuration, recreate
`~/.hopper/runner-config.json` from the profile file you ported above —
re-wrap the model map in `{ "opencode": { ... } }` and rename the keys
from `deep`/`balanced`/`fast` back to `opus`/`sonnet`/`haiku`.

Queue state (`~/.hopper/items.json`) and audit history are
forward-and-backward compatible across 2.x and 3.x — neither schema
changed in the runner-config / profile rework. Worktree state likewise.

> Items queued under 3.x carry a `profile` field that 2.x doesn't read.
> Old hoppers will dispatch them as if the field weren't there, which
> means they'll run on whatever `--runner` the 2.x worker was started
> with. For most rollbacks this is fine; just be aware that "the profile
> I picked at add-time" stops being honoured the moment you downgrade.

## Bug-fix worth noting

3.0 fixes a bug that affected from-scratch project generation in 2.x:
the engineering commit-message step sometimes received an empty diff
(because `git diff HEAD` excludes untracked files) and Haiku responded
with a meta-complaint that became the commit message. If you've seen
commits with messages like *"I don't see a diff summary in your message
— the 'Diff summary:' section is empty…"*, that's the same bug. It's
fixed in 3.0 with no migration needed.
