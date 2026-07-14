---
layout: home

hero:
  name: Hopper
  text: Personal work queue CLI
  tagline: Dispatch engineering tasks to Claude Code or opencode. Pure functions, gateway pattern, deterministic worktrees, runner-agnostic.
  actions:
    - theme: brand
      text: Migration 2.x → 3.x
      link: /migration-2.x-to-3.x
    - theme: alt
      text: GitHub
      link: https://github.com/svetzal/hopper
    - theme: alt
      text: Releases
      link: https://github.com/svetzal/hopper/releases

features:
  - icon: ⚙️
    title: Two runners, one contract
    details: Claude Code (default) or opencode (--runner opencode). Both implement the same AgentRunner interface; phase wiring and audit rendering are runner-agnostic.

  - icon: 🎚️
    title: Vendor-agnostic model tiers
    details: Address models as deep / balanced / fast. Each runner translates — claude maps to opus/sonnet/haiku natively, opencode maps via ~/.hopper/runner-config.json to whatever provider/model you bind.

  - icon: 🧠
    title: Per-phase reasoning effort
    details: SessionOptions.effort flows to --effort on claude and --variant on opencode. Per-phase defaults — plan/validate=high, execute=medium — set in task-type-workflow.ts.

  - icon: 🔁
    title: Engineering pipeline
    details: Plan → execute → validate, with one remediation pass on validate failure. Hopper owns sync, worktrees, commit, merge, push, and cleanup. Agent git mutations are blocked across POSIX runners, including default tasks.

  - icon: 🧪
    title: Functional core + imperative shell
    details: Workflow decisions live in pure functions. I/O is isolated behind gateway interfaces (GitGateway, AgentRunner, FsGateway, etc.). 1,000+ unit tests, fast suite (~2s).

  - icon: 📜
    title: Trustworthy audit trail
    details: Every session streams JSONL to ~/.hopper/audit/<id>-<phase>.jsonl as it runs. opencode runs append a synthetic opencode-export event with model id, variant, tokens, cost.
---

## Install

Hopper ships as a single statically-compiled binary on macOS, Linux, and Windows.

```bash
# Via Homebrew tap
brew install svetzal/tap/hopper

# Or grab the binary from the latest release
# https://github.com/svetzal/hopper/releases
```

After install, drop the Hopper coordinator skill into your global Claude config:

```bash
hopper init
```

Use `hopper init --local` if you want the coordinator skill installed in the current project's `.claude/skills/` instead of your global Claude config.

## Quick start

Queue an engineering task in a local git repo:

```bash
hopper add "Add --quiet flag that suppresses non-error CLI output" \
  --type engineering \
  --dir ~/Work/Projects/my-project \
  --branch main
```

Start a worker (claude is the default; pass `--runner opencode` to use opencode instead):

```bash
hopper worker --once          # process one item then exit
hopper worker                 # poll forever (default 60s)
```

The worker creates a git worktree, runs the plan/execute/validate pipeline, commits, fast-forwards to main, and pushes. Every action is auditable.

## Why a third runner-agnostic version

Hopper 3.0 introduces an alternative agent runner so the same engineering pipeline can be driven by Claude Code (Anthropic) or by [opencode](https://opencode.ai) (any of OpenAI, OpenRouter, AWS Bedrock, etc., depending on which models you bind).

This brings two practical benefits:

1. **Provider portability** — when one provider has an outage, throttles, or changes pricing, swap runners at the worker level: `hopper worker --runner opencode`. No code changes.
2. **Vendor-honest semantics** — model selection is expressed as a tier (`deep` / `balanced` / `fast`) rather than a vendor alias. Worker log lines name the tier, so a run on `openai/gpt-5.5` no longer pretends to be running on `opus`.

See the [2.x → 3.x migration guide](/migration-2.x-to-3.x) for upgrade instructions and the [opencode CLI spike](/opencode-spike) for the empirical findings that shaped the implementation.
