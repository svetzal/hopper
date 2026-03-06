---
name: epilogue-tracker
description: Use Epilogue Tracker (et) for user-centric product planning with the Screenplay Pattern. Use this skill whenever the user mentions actors, goals, interactions, journeys, the Screenplay Pattern, product planning, work breakdown, who benefits from work, product charter, or any et CLI commands. Also use when the user asks about structuring work around user needs rather than tasks.
et_version: 1.0.0
---

# Epilogue Tracker - Product Planning with the Screenplay Pattern

Epilogue Tracker (`et`) is a CLI tool that serves as the control layer between product intent and implementation. It maintains a living screenplay of actors, goals, and interactions that agents translate directly into working software. The screenplay is the specification. Technology decisions belong in agent guidance (AGENTS.md files), never in work items.

## Philosophy

Work matters when it helps real people achieve their goals. The Screenplay Pattern organises work around:

- **Actors** - Real people who use your product (not team roles)
- **Goals** - What those people want to achieve (not product milestones)
- **Interactions** - How your product helps them get there (not tasks)
- **Journeys** - The complete path from need to satisfaction (not sprints)

**The Three Questions** - Before starting any work, ask:

1. **Which user (actor) benefits from this?**
2. **What goal of theirs does this support?**
3. **What interaction describes how this helps them?**

If you cannot answer these, the work may not be justified.

**The Epilogue** - In storytelling, the epilogue shows how things turned out for the characters. In Epilogue Tracker, when an actor achieves their goal, the story has a satisfying ending. The true definition of "done" is real people helped, not tasks completed.

**Not a task tracker.** Epilogue Tracker deliberately has no stories, estimates, boards, velocity, or sprint planning. It specifies intent and delegates to agentic workers. The product charter's out-of-scope field makes these boundaries explicit for each product.

## Setup

### .et_env Configuration

A user will typically download an `.et_env` file from their Epilogue Tracker web console (eg https://app.epiloguetracker.ca) and place it in their project folder.

It looks like this:

```
ET_API_HOST=https://app.epiloguetracker.ca/
ET_API_TOKEN=product-specific-secret-api-token
```

> **IMPORTANT:** `.et_env` contains secrets. It is gitignored and must never be committed.

### Install Skill Files

Run `et init` to install (or update) the AI agent skill files into `.claude/skills/epilogue-tracker/`. This is how these skill files you are reading were installed. Run it again after upgrading `et` to get updated documentation.

```bash
et init [--json]
```

### Critical: Working Directory

The `et` CLI reads `.et_env` from the current working directory only. It does **not** walk up the directory tree.

**You MUST run `et` from the project root directory where `.et_env` lives.**

If `et` returns empty results unexpectedly, the problem is almost certainly that your current working directory is not the project root, and/or the `.et_env` is not present there.

### JSON Output

**Always use `--json` for agent interactions.** This ensures consistent, parseable output:

```bash
et list --json
et create actor --id "customer" --name "Customer" --description "An online shopper" --json
```

## Product Charter

The charter defines the product's mission, audience, problem space, differentiators, and explicit boundaries. Read it first when encountering a new project. It shapes which actors matter, what goals are in scope, and what work is not justified.

```bash
# Read the charter
et charter --json

# Set or update charter fields
et charter set --mission "Help teams ship better software" --json
et charter set --target-audience "Product managers and technical cofounders" --json
et charter set --problem-space "Gap between knowing what to build and having it built" --json
et charter set --differentiators "Agent-consumable specification of product intent" --json
et charter set --out-of-scope "Not a task tracker, Kanban board, or ticketing system" --json
```

**Charter fields:**

| Field | Flag | Purpose |
|-------|------|---------|
| Mission | `--mission` | Core purpose of the product |
| Target Audience | `--target-audience` | Who the product serves (these become your actors) |
| Problem Space | `--problem-space` | The problem being solved |
| Differentiators | `--differentiators` | What makes this product unique |
| Out of Scope | `--out-of-scope` | What the product deliberately does not do |

The charter's target audience directly informs which actors to create. Its out-of-scope field helps you reject work that falls outside product boundaries. When unsure whether work is justified, consult the charter.

## Entity Model

| Type | Purpose | Has State |
|------|---------|-----------|
| **Actor** | A user role - the "who" | Yes (seven-state lifecycle) |
| **Goal** | What the user wants to achieve - the "why" | Yes (seven-state lifecycle) |
| **Interaction** | How your product helps them - the "how" | Yes (seven-state lifecycle), has priority |
| **Journey** | The complete path to satisfaction - the "script" | Yes (seven-state lifecycle) |

All entity types share the same seven states: `plan` (default), `create`, `created`, `update`, `delete`, `deleted`, `discarded`. See [references/entity-model.md](references/entity-model.md) for the full state machine.

### Relationships

```
Actor ──has──▶ Goals ◀──supports── Interactions
  │               ▲                     │
  │               │                     │
  └───────────────┼─────────────────────┘
                  │
              Journey
        (ties Actor + Goal +
         ordered Interactions)
```

### Key Rules

- **Goals are always user goals.** "Log in securely without remembering passwords" not "Implement OAuth."
- **Interactions always tie to goals.** If you cannot link work to a user goal, question the work.
- **Journey actors are protagonists.** The journey's actor is who benefits, even if individual steps are performed by different actors.
- **Technology decisions stay out of entities.** Architecture, patterns, and constraints belong in AGENTS.md or coding standards, not in goals or interactions.
- **Validate regularly.** Run `et validate --json` to catch broken references and orphan entities so that you can raise that with the user.

### Naming Entities

Every entity has an `--id` (machine-readable, snake_case) and most support a `--name` (human-friendly display name). Always provide `--name` when creating goals, interactions, and journeys. The name appears in listings and reports, making the model readable by people. For actors, `--name` is required.

| Entity | `--name` | Example ID | Example Name |
|--------|----------|------------|--------------|
| Actor | Required | `online_shopper` | "Online Shopper" |
| Goal | Optional (defaults to id) | `fast_checkout` | "Fast Checkout" |
| Interaction | Optional (defaults to id) | `express_payment` | "Express Payment" |
| Journey | Optional (defaults to id) | `checkout_flow` | "Checkout Flow" |

## Core Workflow

1. **Read the charter** (first time, or when unsure about scope):
   ```bash
   et charter --json
   ```

2. **Review outstanding work:**
   ```bash
   et list --json
   ```

3. **Identify or create the Actor** who benefits:
   ```bash
   et show actor customer --json
   # If not found:
   et create actor --id "customer" --name "Customer" --description "An online shopper" --json
   ```

4. **Identify or create the Goal** this work supports:
   ```bash
   et list goals --actor customer --format json
   # If not found:
   et create goal --id "fast_checkout" --name "Fast Checkout" --description "Complete purchase quickly and confidently" --actor "customer" --json
   ```

5. **Create the Interaction** describing how this helps:
   ```bash
   et create interaction --id "express_payment" --name "Express Payment" --description "One-click payment using saved details" --performed-by "customer" --goal "fast_checkout" --priority 1 --json
   ```

6. **Approve for implementation:**
   ```bash
   et approve interaction express_payment --json
   et approve goal fast_checkout --json
   ```

7. **Do the work** - implement the feature, fix the bug, refactor the code.

8. **Close completed items** (transitions to `created`):
   ```bash
   et close interaction express_payment --json
   et close goal fast_checkout --json
   ```

9. **Validate:**
   ```bash
   et validate --json
   ```

## Essential Commands

### Create Entities

```bash
# Actor (required: --id, --name, --description)
et create actor --id "customer" --name "Customer" --description "End user seeking to accomplish tasks efficiently" --json

# Goal (required: --id, --description; always provide --name)
et create goal --id "checkout" --name "Checkout" --description "Complete purchase successfully" --actor "customer" --success-criteria "Order placed, payment processed, confirmation received" --json

# Interaction (required: --id, --description; always provide --name)
et create interaction --id "add_to_cart" --name "Add to Cart" --description "Add products to shopping cart" --performed-by "customer" --goal "checkout" --priority 1 --json

# Journey (required: --id, --actor, --goal, --steps; always provide --name or --narrative)
et create journey --id "checkout_flow" --name "Checkout Flow" --actor "customer" --goal "checkout" --steps "browse,add_to_cart,pay" --narrative "Customer finds products, builds cart, completes purchase" --json
```

### List Entities

```bash
et list --json                                    # Tree view of all work
et list actors --format json                      # All actors
et list goals --format json --actor customer      # Goals for actor
et list interactions --format json --goal checkout # Interactions for goal
et list journeys --format json                    # All journeys

# State filtering
et list goals --format json                       # Active only (excludes deleted/discarded)
et list goals --format json --state create        # Specific state only
et list goals --format json --all                 # All with state

# Tag filtering
et list goals --format json --tag "verified"      # Single tag
et list goals --format json --tag "legacy,new"    # Multiple tags (OR matching)
```

### Show Entity Details

```bash
et show actor customer --json
et show goal checkout --json
et show interaction add_to_cart --json
et show journey checkout_flow --json
```

### Update Entities

```bash
et update goal checkout --success-criteria "Updated criteria" --json
et update interaction add_to_cart --description "Updated description" --json
et update actor customer --add-tags "premium" --meta "tier=gold" --json
```

### Remove Entities

```bash
et remove interaction old_step --json            # Warns if referenced
et remove interaction old_step --force --json    # Force removal
```

### Approve and Discard

```bash
et approve goal checkout --json                  # plan -> create
et approve interaction add_to_cart --json        # plan -> create
et discard goal unused --json                    # plan -> discarded
```

### Close and Reopen

```bash
et close goal checkout --json                    # create/update -> created
et close interaction add_to_cart --json          # create/update -> created
et close actor customer --json                   # Works on all entity types
et reopen goal checkout --json                   # created -> update
```

### Validate

```bash
et validate --json
```

Returns errors (broken references, must fix) and warnings (orphan entities, should review). Exit code 1 if errors exist.

### Jam Session

```bash
et jam
```

Opens an interactive LLM chat where you think out loud about your product. The LLM understands the Screenplay Pattern and has tools to read and modify entities (actors, goals, interactions, journeys). It will confirm before making changes.

**Prerequisites:** `OPENAI_API_KEY` must be set in `.et_env` or as an environment variable.

**Session commands:** `/quit` or `/exit` to end the session.

## Challenging Work Without User Goals

Before any work, apply the Three Questions. Check the product charter's out-of-scope field to confirm the work belongs in this product at all. Then reframe technical tasks as user outcomes:

| Task-Focused (Bad) | User-Focused (Good) |
|---------------------|---------------------|
| "Add database indexes" | "Browse products without delays" |
| "Implement 2FA" | "Feel confident my account is protected" |
| "Refactor checkout module" | "Complete purchase quickly and confidently" |
| "Add caching layer" | "Experience fast, responsive page loads" |

**When work seems purely technical**, trace it to the user:
- Why add indexes? Queries are slow. Why does that matter? Pages load slowly. Who is affected? Customers browsing products. **User goal found.**

**When no user can be identified:**
- Internal tooling? Your users might be developers or ops teams. They are valid actors.
- Pure tech debt with no user impact? Consider waiting until it blocks user value.
- "Nice to have"? If no user needs it, consider skipping it.
- Falls outside the charter's scope? Flag it to the user rather than creating entities for it.

For detailed examples of decomposing features, bugs, and tech debt, see [workflows/breaking-down-work.md](workflows/breaking-down-work.md).

## ID Format

Entity IDs must:
- Contain only letters, numbers, underscores, and hyphens
- Be 1-100 characters long
- Not contain path separators or ".."

## Tags and Metadata

All entity types support tags and metadata for categorisation and filtering:

```bash
# Tags: categorise and filter
et create goal --id "checkout" --name "Checkout" --description "..." --tags "verified,production" --json
et update goal checkout --add-tags "priority" --json
et update goal checkout --remove-tags "unverified" --json
et list goals --format json --tag "verified"

# Metadata: arbitrary key-value pairs
et create actor --id "admin" --name "Admin" --description "..." --meta "login_hint=admin@example.com" --json
et update actor admin --meta-json '{"role":"superuser"}' --json
et update actor admin --remove-meta "old_key" --json
```

## Supporting Files

For deeper reference, consult these files as needed:

- **Complete CLI reference** (every command, flag, and option): [references/cli-reference.md](references/cli-reference.md)
- **Entity model detail** (fields, relationships, validation rules): [references/entity-model.md](references/entity-model.md)
- **Getting started in a new project**: [workflows/getting-started.md](workflows/getting-started.md)
- **Breaking down features, bugs, and tech debt**: [workflows/breaking-down-work.md](workflows/breaking-down-work.md)
