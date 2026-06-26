# Profiles

A **profile** is a named bundle of two decisions: *which agent runner do we
dispatch to* and *which concrete model fulfils each tier*. Profiles live as
JSON files under `~/.hopper/profiles/`, get picked per-job by `hopper add`,
and bake into each queue item at add-time so behaviour stays stable across
retries.

Profiles replace the pre-3.0 combination of `~/.hopper/runner-config.json`
plus a global `--runner` flag on the worker. The worker is now
runner-agnostic; runner selection follows the item.

## Motivation

Hopper 2.x asked you to pick a runner once, at the worker, and then bound
every queued item to whatever that worker happened to be running. The
result was a tight coupling between *what you wanted built* and *which CLI
was running when you queued it*.

The 3.0 redesign turns that around:

- **Runner + model selection are properties of the work**, not the worker.
- **A single worker can drain a queue containing items dispatched to
  different runners** — claude for one item, opencode against OpenAI for
  the next, opencode against ollama for the next.
- **Switching providers is a per-job flag** (`hopper add --profile ...`),
  not a worker restart.
- **The choice is recorded on the item** the moment you queue it, so
  retries, restarts, and audit replays all see the same runner + model
  bindings regardless of subsequent edits to the profile file.

Profiles also collapse the old two-file configuration surface
(`runner-config.json` for opencode + the implicit claude defaults) into
one file per named bundle.

## Where profiles live

```text
~/.hopper/
  config.json                { "defaultProfile": "openai" }
  profiles/
    anthropic.json           # claude runner — opus / sonnet / haiku
    openai.json              # opencode runner — gpt-5.5 / 5.4 / 5.4-mini
    openrouter.json          # opencode runner — glm-5.1 + others
    ollama.json              # opencode runner — local qwen3.6 family
```

`config.json` records exactly one piece of state: which profile is used
when `hopper add` is invoked without `--profile`. Every other knob lives
inside the individual profile file.

## Profile file shape

Each profile is a small JSON object with two top-level keys: `runner` and
`models`.

```json
{
  "runner": "opencode",
  "models": {
    "deep":     "ollama/qwen3.6:27b-coding-bf16",
    "balanced": "ollama/qwen3.6:27b-coding-mxfp8",
    "fast":     "ollama/qwen3.6:35b-a3b-coding-nvfp4"
  }
}
```

### `runner`

One of `"claude"` or `"opencode"`. Hopper invokes the matching CLI when a
session for an item on this profile is dispatched. Anything else is a
validation error.

### `models`

A map from tier name (or user-defined alias) to a runner-native model
identifier.

Three keys are **required** in every profile:

- `deep` — used for planning and investigation phases
- `balanced` — used for the execute phase
- `fast` — used for one-shots (branch slug, commit message, validate-marker
  fallback)

Additional keys are allowed as user-defined aliases (see [Authoring your
own profile](#authoring-your-own-profile) below).

Each entry takes one of two forms:

**Shorthand** — bare model string. Effort follows the per-phase workflow
default (plan/validate = `high`, execute = `medium`):

```json
"deep": "opus"
```

**Object form** — model plus optional `effort` override. The profile's
effort wins over the per-phase default, so you can pin a tier to a
specific level:

```json
"deep":     { "model": "opus",   "effort": "max" },
"balanced": "sonnet",
"fast":     { "model": "haiku",  "effort": "low" }
```

Effort vocabulary: `minimal | low | medium | high | max` (hopper's
unified set). Each runner translates:

- claude → `--effort <value>` (`minimal` maps to `low`; `max` reaches
  claude's `xhigh`/`max` ceiling)
- opencode → `--variant <value>` (forwarded verbatim — the underlying
  provider decides supported levels)

Runner-native strings outside the canonical set are forwarded as-is;
the CLI surfaces the error if invalid.

The right-hand-side model identifier is whatever the underlying runner
accepts:

- For `runner: "claude"`, the Anthropic-flavoured aliases (`opus`,
  `sonnet`, `haiku`) or explicit Claude model IDs (`claude-opus-4-7`).
- For `runner: "opencode"`, the `provider/model` form opencode expects
  (`openai/gpt-5.5`, `openrouter/z-ai/glm-5.1`, `ollama/qwen3.6:...`).

## The four shipped templates

On first use, hopper writes four profile templates to
`~/.hopper/profiles/`. Pick whichever matches your provider and edit it,
or duplicate one as a starting point for your own.

### `anthropic`

```json
{
  "runner": "claude",
  "models": {
    "deep": "opus",
    "balanced": "sonnet",
    "fast": "haiku"
  }
}
```

Dispatches through the `claude` CLI. Pick this if you have a direct
Anthropic API key configured locally. It is **not** the default — see
[Bootstrap behaviour](#bootstrap-behaviour) below for why.

### `openai`

```json
{
  "runner": "opencode",
  "models": {
    "deep": "openai/gpt-5.5",
    "balanced": "openai/gpt-5.4",
    "fast": "openai/gpt-5.4-mini",
    "gpt-5.3-codex": "openai/gpt-5.3-codex"
  }
}
```

Dispatches through `opencode` against OpenAI. This is the default
profile — see below.

### `openrouter`

```json
{
  "runner": "opencode",
  "models": {
    "deep": "openrouter/z-ai/glm-5.1",
    "balanced": "openrouter/anthropic/claude-sonnet-4-6",
    "fast": "openrouter/google/gemini-2-flash",
    "glm-5.1": "openrouter/z-ai/glm-5.1"
  }
}
```

Dispatches through `opencode` against OpenRouter. Useful when you want
cross-provider model selection (deep on GLM, balanced on Claude, fast on
Gemini) without juggling multiple API keys at the runner level.

### `ollama`

```json
{
  "runner": "opencode",
  "models": {
    "deep": "ollama/qwen3.6:27b-coding-bf16",
    "balanced": "ollama/qwen3.6:27b-coding-mxfp8",
    "fast": "ollama/qwen3.6:35b-a3b-coding-nvfp4",
    "qwen-bf16": "ollama/qwen3.6:27b-coding-bf16",
    "qwen-mxfp8": "ollama/qwen3.6:27b-coding-mxfp8",
    "qwen-nvfp4": "ollama/qwen3.6:35b-a3b-coding-nvfp4",
    "gpt-oss-120b": "ollama/gpt-oss:120b",
    "gpt-oss-20b": "ollama/gpt-oss:20b"
  }
}
```

Dispatches through `opencode` against a local ollama instance. Useful for
offline work and for sanity-checking expensive remote models against a
local baseline.

## Picking a profile per job

The `--profile` flag on `hopper add` selects which profile a queued item
runs against:

```bash
hopper add "Refactor the prompt builder" \
  --type engineering \
  --dir ~/Work/Projects/my-project \
  --branch main \
  --profile ollama
```

Resolution order:

1. `--profile <name>` if passed.
2. Otherwise, `defaultProfile` from `~/.hopper/config.json`.

Either way, the resolved profile name is **baked into the item** at
add-time (`item.profile`). The worker reads that field each time it picks
up the item — including on retry — and dispatches accordingly. Editing
`config.json` after the item is queued does not retroactively change
which profile the item runs under.

If the named profile doesn't exist, `hopper add` refuses to queue the
item and lists the profiles it found on disk so you can pick a valid one.

## Listing and inspecting profiles

### `hopper profiles`

Lists every profile installed under `~/.hopper/profiles/`. The default
profile is starred:

```text
Default profile: openai

  anthropic  (claude)
      deep:     opus
      balanced: sonnet
      fast:     haiku
  codex  (codex)
      deep:     gpt-5.5
      balanced: gpt-5.4
      fast:     gpt-5.4-mini
* openai  (opencode)
      deep:     openai/gpt-5.5
      balanced: openai/gpt-5.4
      fast:     openai/gpt-5.4-mini
  openrouter  (opencode)
      deep:     openrouter/z-ai/glm-5.1
      balanced: openrouter/anthropic/claude-sonnet-4.6
      fast:     openrouter/google/gemini-2.5-flash
  ollama  (opencode)
      deep:     ollama/qwen3.6:27b-coding-bf16
      balanced: ollama/qwen3.6:27b-coding-mxfp8
      fast:     ollama/qwen3.6:35b-a3b-coding-nvfp4
```

Tiers with an `effort` override get a trailing `(effort: <value>)`
suffix:

```text
  anthropic-max  (claude)
      deep:     opus  (effort: max)
      balanced: sonnet
      fast:     haiku  (effort: low)
```

If a profile file fails to parse, its name appears under a trailing
`Errors:` section with the validation message — the rest of the list
still renders.

### `hopper profiles show <name>`

Prints a single profile's contents (the `runner` + `models` fields, the
same JSON shape as the file on disk) with the absolute path as a comment
header. Useful when you want to copy a shipped template as the starting
point for a new one.

## Bootstrap behaviour

On the first command that touches `~/.hopper/` (typically `hopper add` or
`hopper profiles`), hopper checks whether `config.json` and the
`profiles/` directory already exist and fills in any missing shipped
profiles. If config is missing, it writes:

- `~/.hopper/config.json` with `{"defaultProfile": "openai"}`.
- Shipped profile files (`anthropic`, `codex`, `openai`, `openrouter`,
  `ollama`) under `~/.hopper/profiles/`.

Bootstrap is **idempotent**: any file that already exists is left
untouched. You can safely delete one of the shipped profiles and have
hopper re-create it on the next bootstrap, or edit a profile in place
without fear of being clobbered.

### Why `openai` is the default

The shipped `defaultProfile` is `openai`, not `anthropic`. This is a
bootstrap convenience: a fresh `hopper add` on a clean machine runs on an
OpenAI-backed runner without any extra wiring.

The `anthropic` profile (the `claude` runner) is fully supported. Switch
to it explicitly per-item with `--profile anthropic`, or make it your
default once and for all by setting `defaultProfile` in
`~/.hopper/config.json`.

### Auth tokens expire — a 401 means re-login, not an outage

The `claude` and `codex` runners authenticate with OAuth tokens that
expire periodically. When a token lapses, items fail at the plan or exec
phase with:

```
401 Invalid authentication credentials
```

This is a **local login expiry**, not a service outage or a policy
change. Re-authenticate (`claude` / `codex` login) and
`hopper requeue <id>` the affected item. To confirm it's just auth, run the runner
directly — e.g. for the `claude` runner:

```
echo "reply with OK" | claude -p
```

A `401` there means the token has expired; an `OK` means the runner is
fine and the failure was something else.

## Authoring your own profile

Profiles are plain JSON files. To create one, drop a file at
`~/.hopper/profiles/<name>.json`:

```json
{
  "runner": "opencode",
  "models": {
    "deep": "openrouter/anthropic/claude-opus-4-7",
    "balanced": "openrouter/openai/gpt-5.4",
    "fast": "openrouter/google/gemini-2-flash",
    "experimental": "openrouter/z-ai/glm-5.1"
  }
}
```

After saving, the profile is immediately available via
`hopper add --profile <name>`. No `hopper reload`, no daemon restart.

### Validation rules

These are checked when a profile is loaded (every `hopper add` and every
`hopper profiles` invocation):

- **Profile name** must match `[a-z0-9_-]+`. The name is the filename
  minus `.json`. Anything outside that vocabulary (uppercase, spaces,
  dots) is rejected at load time — names live as filenames on disk and
  shell-quoting fragile names is more pain than it's worth.
- **`runner`** must be exactly `"claude"` or `"opencode"`.
- **`models`** must be an object. Each entry is either a non-empty
  string (model name only) or an object `{ "model": "...", "effort":
  "..." }` where `model` is required and non-empty and `effort`, if
  present, is a non-empty string. Both forms normalize to the same
  internal binding.
- **Required tier keys** `deep`, `balanced`, and `fast` must all be
  present. Missing any one of them rejects the profile.

A profile that fails validation appears in `hopper profiles` under the
`Errors:` section with the specific failure (`Invalid 'runner' …`,
`Missing required tier 'fast' in models`, etc.). It does not silently
fall back to defaults.

### User-defined aliases

Beyond the three required tiers, you can add any number of additional
keys to the `models` map. These behave exactly like tier names when
resolved — they're just less constrained vocabulary for the same lookup
table.

Two common uses:

```json
{
  "runner": "opencode",
  "models": {
    "deep":         "ollama/qwen3.6:27b-coding-bf16",
    "balanced":     "ollama/qwen3.6:27b-coding-mxfp8",
    "fast":         "ollama/qwen3.6:35b-a3b-coding-nvfp4",
    "qwen-bf16":    "ollama/qwen3.6:27b-coding-bf16",
    "gpt-oss-120b": "ollama/gpt-oss:120b"
  }
}
```

- **Memorable shorthand for a specific model** — `qwen-bf16` resolves to
  the same string as `deep`, but it's a name you can pass explicitly when
  you know you want *that* model regardless of which tier it currently
  serves. Useful when you're rotating tier bindings during evaluation.
- **Models that don't fit the three-tier scheme** — alternative models
  you want to address by alias rather than by full
  `provider/model[:variant]` ID, but that aren't part of the canonical
  rotation.

Custom code calling `SessionOptions.model` directly can pass either tier
names or user aliases; both resolve through the same profile lookup.

### Disabling a profile

To temporarily take a profile out of rotation without deleting it, rename
the file to end in `.disabled`:

```bash
mv ~/.hopper/profiles/ollama.json ~/.hopper/profiles/ollama.json.disabled
```

The profile no longer appears in `hopper profiles` (the lister only
considers `*.json`), and `hopper add --profile ollama` fails with a
`Profile not found` error. Rename it back to re-enable.

### Switching the default

Edit `~/.hopper/config.json`:

```json
{
  "defaultProfile": "ollama"
}
```

The change takes effect on the next `hopper add` that doesn't pass
`--profile`. Already-queued items keep their baked-in profile name.

## Determinism guarantees

The profile name on an item is the profile name that was resolved when
`hopper add` ran. Concretely:

- Editing `~/.hopper/config.json`'s `defaultProfile` after queuing does
  not change which profile the queued item runs under.
- Renaming or deleting a profile file *will* break the item the next
  time the worker picks it up — the worker resolves the profile by name
  at dispatch time, so a missing file surfaces as a loud error rather
  than a silent substitution.
- Editing the contents of a profile file (changing a model binding, for
  example) **does** affect subsequent dispatches of items already
  queued under that profile name. The profile name is baked in; the
  bindings inside the profile are resolved fresh each time. This is
  intentional — it's how you roll out a model change to in-flight
  queues.

## Related

- [Migration 2.x → 3.x](/migration-2.x-to-3.x) — what changed when
  profiles replaced `runner-config.json`.
- [opencode CLI spike](/opencode-spike) — the empirical findings that
  shaped how opencode is wired in.
- [Changelog](https://github.com/svetzal/hopper/blob/main/CHANGELOG.md) —
  full release history.

The vendor-agnostic `deep`/`balanced`/`fast` tier vocabulary itself
predates profiles and is documented further in the
[overview](/) and the [migration guide](/migration-2.x-to-3.x). Profiles
are how those tiers get bound to concrete models on a per-job basis.
