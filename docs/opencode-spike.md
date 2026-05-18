# OpenCode CLI Spike — Findings

Captured 2026-05-17 using `opencode` v1.15.3 to inform a hopper runner abstraction
that can dispatch to either Claude Code or opencode.

This document is empirical — every claim was verified by running a command and
inspecting its output. Where the docs at <https://opencode.ai/docs> diverge from
observed behaviour, observed behaviour wins.

## Bottom line

OpenCode's headless surface is **runnable but semantically different from
Claude Code**. Three structural differences shape the integration:

1. **No CLI flags for tool/permission allowlists, agents-as-flags, or
   system-prompt overrides.** All of that lives in `opencode.json` (per-project
   or inline via `OPENCODE_CONFIG_CONTENT`). The only CLI knob for permissions
   is the binary `--dangerously-skip-permissions`.
2. **No terminal result event in the JSON stream.** Claude's `{"type":"result",
   "result":"..."}` line has no opencode equivalent. The final assistant text
   must be reconstructed by collecting `text` parts as they arrive, or — much
   more cleanly — by `opencode export <sessionID>` after the run completes.
3. **Exit code 0 does NOT mean success.** Opencode returns 0 even when its
   stream contains `{"type":"error", ...}` events. Hopper must scan the stream
   for error events to decide outcome, not trust the exit code alone.

These three points collectively mean the cleanest runner pattern is:
**stream the JSON to the audit file for live visibility, then call
`opencode export <sessionID>` post-run to get the canonical result + cost +
token counts**, and **scan the stream for `type=error` events to determine
success/failure** rather than relying on the exit code.

## CLI surface (verified)

```
opencode run [message..]
  -m, --model <provider/model>   model selection (provider/model format)
  -c, --continue                 continue last session
  -s, --session <id>             continue specific session
      --fork                     fork session when continuing
      --agent <name>             agent to use
      --format default|json      JSON gives raw event stream (newline-delimited)
  -f, --file <path>              attach files (repeatable)
      --title <text>             session title
      --dir <path>               cwd for the session (equivalent of claude's cwd)
      --variant <level>          provider-specific reasoning effort
      --thinking                 emit thinking blocks
      --dangerously-skip-permissions   bypass interactive permission prompts
      --print-logs               logs to stderr
      --log-level DEBUG|INFO|WARN|ERROR
```

**Notably absent** (these all exist on `claude` and hopper currently uses them):

| Claude flag | Opencode equivalent |
|---|---|
| `--print` | implicit — `opencode run` is the headless mode |
| `--output-format stream-json` | `--format json` |
| `--tools Read,Grep,...` | **none** — use `opencode.json` `permission` block |
| `--allowedTools` | **none** |
| `--disallowedTools` | **none** |
| `--permission-mode plan` | **none** — `--dangerously-skip-permissions` is binary |
| `--append-system-prompt` | **none at CLI** — must be done via agent config |

## Adjacent subcommands worth knowing

```
opencode export [sessionID]            # canonical JSON dump of a session
opencode session list                  # list known sessions
opencode session delete <sessionID>    # garbage-collect a session
opencode agent list                    # list available agents (incl. defaults)
opencode agent create                  # create a new custom agent
opencode providers list                # auth state per provider
opencode models [provider]             # list available models
opencode stats                         # token + cost stats
opencode db                            # raw db tools
```

`opencode export` is the highest-leverage command for hopper integration —
see the "result extraction" section below.

## JSON event schema (verified)

Newline-delimited JSON; each line is one event. Common envelope:

```jsonc
{
  "type": "<event-type>",
  "timestamp": 1779072806579,        // unix millis
  "sessionID": "ses_1c6ff5d8ffe...",
  "part": { /* type-specific payload */ }
}
```

Event types observed:

| `type` | Meaning | Notes |
|---|---|---|
| `step_start` | New assistant step begins | `part.type === "step-start"` |
| `text` | Assistant text part | `part.text` contains the chunk; multiple `text` events compose the final message |
| `error` | Provider / runtime error | `error.name` + `error.data.message`; **does not change exit code** |

Additional event types not observed in our minimal spike but inferable from the
schema (will need verification when the runner is exercised against tool-using
prompts): `tool_use`, `tool_result`, message-level `step_finish`, possibly
`reasoning`. The runner implementation should treat unknown `type` values as
opaque pass-through (write to audit, ignore for outcome decisions).

**No terminal result/finish event was emitted.** The stream simply ends.

## Concrete captures

### Success case — `opencode run --format json --model opencode/deepseek-v4-flash-free "Respond with exactly the word PONG and nothing else."`

```jsonl
{"type":"step_start","timestamp":1779072805321,"sessionID":"ses_1c6ff5d8fffeMFVS42RvmPEpt5","part":{"id":"prt_e3900a9c7001RUQ78FHLVfza0m","messageID":"msg_e3900a2cb001Ptj7MY9Bgn6URS","sessionID":"ses_1c6ff5d8fffeMFVS42RvmPEpt5","type":"step-start"}}
{"type":"text","timestamp":1779072806579,"sessionID":"ses_1c6ff5d8fffeMFVS42RvmPEpt5","part":{"id":"prt_e3900ae92001nsAXh5A5e8OgRl","messageID":"msg_e3900a2cb001Ptj7MY9Bgn6URS","sessionID":"ses_1c6ff5d8fffeMFVS42RvmPEpt5","type":"text","text":"PONG","time":{"start":1779072806546,"end":1779072806577}}}
```

Exit code: `0`.

### Failure case — invalid model id

```jsonl
{"type":"error","timestamp":1779072542220,"sessionID":"ses_1c7035a56ffeLPMwy1xE3hcwgh","error":{"name":"UnknownError","data":{"message":"Model not found: ollama/gpt-oss:20b."}}}
```

Exit code: **`1`** (here) for opencode-internal model-resolution failure, but
**`0`** for downstream provider failures (e.g. ollama returning 404 for a
configured-but-not-pulled model):

```jsonl
{"type":"error","timestamp":1779072555942,"sessionID":"ses_1c7032507ffeJ53BrsgW09cGEs","error":{"name":"APIError","data":{"message":"model 'qwen3.5:35b-a3b-coding-nvfp4' not found","statusCode":404,...}}}
```

→ **Exit code alone is not a reliable success signal.** Scan for `type=error`.

### `opencode export <sessionID>` canonical dump

Returned as a single JSON document on stdout (prefixed by a non-JSON status
line `Exporting session: <id>` — strip the first line or pipe through `tail
-n +2` before parsing). Shape:

```jsonc
{
  "info": {
    "id": "ses_1c6ff5d8fffeMFVS42RvmPEpt5",
    "slug": "curious-island",
    "projectID": "global",
    "directory": "/private/tmp/opencode-spike",
    "title": "New session - 2026-05-18T02:53:23.440Z",
    "agent": "build",
    "model": { "id": "deepseek-v4-flash-free", "providerID": "opencode", "variant": "default" },
    "version": "1.15.3",
    "summary": { "additions": 0, "deletions": 0, "files": 0 },
    "cost": 0,
    "tokens": { "input": 14199, "output": 3, "reasoning": 17, "cache": { "read": 0, "write": 0 } },
    "permission": [ /* effective permission rules */ ],
    "time": { "created": 1779072803440, "updated": 1779072803552 }
  },
  "messages": [
    { "info": { "role": "user", ... }, "parts": [ { "type": "text", "text": "..." } ] },
    { "info": { "role": "assistant", ..., "tokens": {...}, "cost": 0 }, "parts": [ /* one or more parts */ ] }
  ]
}
```

This is the canonical post-run artefact. Extract the final assistant message's
concatenated `text` parts and we have a direct analogue of claude's
`{"type":"result", "result":"..."}` payload — plus tokens, cost, and diff
summary that claude's result event doesn't carry.

## Session & state persistence

Everything lives in **`~/.local/share/opencode/opencode.db`** (SQLite). Relevant
tables (`sqlite3 ~/.local/share/opencode/opencode.db ".schema"`):

- `session` — one row per session. Columns include `id`, `project_id`,
  `slug`, `directory`, `title`, `version`, `agent`, `model`, `cost`,
  `tokens_input`, `tokens_output`, `tokens_reasoning`, `tokens_cache_read`,
  `tokens_cache_write`, `summary_additions`, `summary_deletions`,
  `summary_files`, `permission`, `time_created`, `time_updated`.
- `message` — one row per chat turn (`session_id`, `data` JSON blob).
- `part` — one row per part within a message (text, tool-use, tool-result, ...).
- `todo` — agent-managed todo list per session.
- `permission` — per-project effective permission state.

Implication: a hopper runner can either call `opencode export <id>` (clean,
official) or read the SQLite directly (faster, but couples to undocumented
schema). The export route is strongly preferred.

`--continue` resumes the last session in the current directory;
`--session <id>` resumes a specific one; `--fork` branches from a continuation point.
These will only matter for hopper if we want to mirror Claude's
`session-separator` append behaviour — likely not for v1 (each hopper task is
its own session).

## Tool / permission control — what's actually available

There is no per-invocation tool allowlist or denylist on the command line. The
mechanism is the `permission` config block, which can live in:

- Project: `<cwd>/opencode.json`
- Global: `~/.config/opencode/opencode.json`
- Inline (per-invocation): `OPENCODE_CONFIG_CONTENT` env var (a JSON string)

Permission entries observed in agent-list output have shape:

```jsonc
{ "permission": "*",        "action": "allow", "pattern": "*" }
{ "permission": "doom_loop", "action": "ask",   "pattern": "*" }
{ "permission": "external_directory", "action": "allow", "pattern": "/path/glob/*" }
```

`action` values seen: `allow`, `ask`, (implied) `deny`. `permission` is a
category (`*`, `doom_loop`, `external_directory`, `question`, `plan_enter`,
`plan_exit`, ...) — these are opencode's internal categories and do **not**
map 1:1 to claude's `Bash(git commit:*)` tool-pattern syntax.

**Open question for implementation**: there is no observed opencode equivalent
of denying `Bash(git commit:*)` etc. Opencode appears to gate decisions at a
higher level (was this an external directory access? a destructive shell
command?). The git-mutation denylist hopper enforces today may need to be
restated as either:

- A custom agent that simply does not have shell-execution permission for the
  execute phase, OR
- A wrapper shell on `PATH` that intercepts `git commit`/`git push`/etc., OR
- Trusting opencode's `--dangerously-skip-permissions=false` (default) plus
  agent-level patterns to gate dangerous tool calls interactively.

For hopper specifically, since the execute phase is unattended, the
denylist-as-code approach (wrapper shell on the worker's PATH that exits
non-zero for forbidden git verbs) is likely cleanest.

## Agents

`opencode agent list` already shows a `build (primary)` agent with a large
permission list. The agent definition format is opencode-native and **not
compatible** with claude's `~/.claude/agents/*.md` craftsperson files.

Options for porting hopper's craftsperson concept:

1. **Port craftsperson .md → opencode agents.** Write a one-off migration that
   reads `~/.claude/agents/<name>.md`, extracts its system-prompt body, and
   invokes `opencode agent create` (or writes directly to opencode's
   storage). This is the closest behavioural parity, but couples to opencode's
   agent storage format.

2. **Inject as system prompt via inline config.** Generate a per-invocation
   `OPENCODE_CONFIG_CONTENT` that defines a transient agent with the
   craftsperson's system prompt inlined. Higher leverage, no on-disk state to
   manage.

Recommendation: option 2 for v1 — keep the craftsperson .md files as the
source of truth, translate at invocation time.

## Model identifier mapping (verified against `opencode models`)

Opencode does **not** use the bare `anthropic/claude-*` form quoted in its
docs. The actual identifiers, as of v1.15.3 for this user's environment:

| Hopper alias | Best opencode equivalent |
|---|---|
| `opus` | `amazon-bedrock/global.anthropic.claude-opus-4-7` (AWS creds) or `openrouter/anthropic/claude-opus-4.7` (paid) |
| `sonnet` | `amazon-bedrock/anthropic.claude-sonnet-4-6` or `openrouter/anthropic/claude-sonnet-4.6` |
| `haiku` | `amazon-bedrock/anthropic.claude-haiku-4-5-20251001-v1:0` or `openrouter/anthropic/claude-haiku-4.5` |

The mapping is **per-environment**: it depends on which providers the user has
configured and authenticated. The runner should not hard-code a mapping —
expose it via `opencode.json` `model` defaults or a per-runner config block in
hopper itself.

## Token / cost reporting

Available via `opencode export <id>` — `info.cost`, `info.tokens.{input,
output, reasoning, cache.{read, write}}` — and per-assistant-message under
`messages[i].info.tokens`. This is **richer** than claude's result event,
which carries only a single cost number.

The session SQLite row carries the same numbers — `cost`, `tokens_input`,
`tokens_output`, `tokens_reasoning`, `tokens_cache_read`, `tokens_cache_write`.

## Stderr

Effectively empty for ordinary runs. Only seen:

```
Shell cwd was reset to /Users/svetzal/Work/Operations
```

— an opencode-internal status line, safe to drop or wrap in a JSONL stderr
event as hopper does today.

## Design implications for the hopper runner

1. **Audit file**: keep the existing JSONL streaming. Each opencode event line
   is written as-is. Same `streamToAuditFile` works.

2. **Result extraction**: do NOT try to mirror claude's stream-result-line
   approach. Instead:
   - Capture the `sessionID` from the first JSON event in the stream.
   - After the process exits, run `opencode export <sessionID> | tail -n +2`
     and parse the JSON.
   - The "result" is the concatenated `text` parts of the final assistant
     message in `messages[]`. The "cost" and "tokens" come from `info`.
   - Append the export JSON to the audit file as a synthesised
     `{"type":"opencode-export", ...}` line so downstream `hopper audit`
     consumers see a self-contained record.

3. **Outcome decision**: success = `exitCode === 0` **AND** the stream contains
   no `{"type":"error"}` events. Either condition failing means the task
   failed.

4. **Permission/tool control**: for v1, use `--dangerously-skip-permissions`
   for all hopper-dispatched runs. The execute-phase git-mutation denylist is
   ported by adding a `git` wrapper shim to the worker's PATH that rejects
   forbidden verbs. The validate-phase allowlist (read-only git) is enforced
   by the same shim. The investigation/plan-phase read-only-mode is enforced
   by giving opencode an agent that has only `Read`/`Grep`/`Glob`/web-tools
   in its permission set.

5. **Agent translation**: at invocation time, generate an inline
   `OPENCODE_CONFIG_CONTENT` JSON that defines an agent whose system prompt
   is the body of `~/.claude/agents/<name>.md`. No on-disk opencode agent
   files are created; the agent exists only for the duration of the run.

6. **Model translation**: a config block (eventually in hopper's own settings,
   not hard-coded) maps `opus|sonnet|haiku` → an opencode model id. Default
   to `amazon-bedrock/...` if AWS creds are present; fall back to
   `openrouter/anthropic/...` if openrouter is authenticated; surface a clear
   error otherwise.

7. **Haiku one-shots** (`generateText` for branch slugs, commit messages,
   validate-fallback assessor) stay on Claude Code unconditionally in v1.
   They're cheap, don't need the agentic surface, and have no behavioural
   reason to route through opencode.

## Remaining unknowns (to verify during runner implementation)

- Exact behaviour of `tool_use` / `tool_result` event types — not observed in
  the minimal spike since the prompt didn't require tools.
- Whether opencode emits a `step_finish` or message-completion event for the
  assistant turn, or whether the stream just ends.
- Exact wire shape of permission denials when `--dangerously-skip-permissions`
  is OFF and a tool would be gated.
- Whether `OPENCODE_CONFIG_CONTENT` truly overrides a project-local
  `opencode.json`, or merges (docs imply cascade).
- Performance of `opencode export` for long sessions — if it's slow, may need
  to fall back to direct SQLite reads.

These are answerable during Phase 2 of the implementation plan
(`/Users/svetzal/.claude/plans/research-the-opencode-cli-majestic-anchor.md`)
without re-doing this spike.
