<!-- et v0.9.0 -->
# Entity Model

The Screenplay Pattern models work through four entity types that answer fundamental questions about who your product serves and why.

## Overview

```
┌─────────────┐     ┌──────────────────┐     ┌───────────────────┐
│    Actor    │────▶│       Goal       │◀────│   Interaction     │
│   (who)     │     │     (why)        │     │     (how)         │
└─────────────┘     └──────────────────┘     └───────────────────┘
       │                    ▲                         │
       │                    │                         │
       └────────────────────┼─────────────────────────┘
                            │
                    ┌───────────────┐
                    │    Journey    │
                    │  (the script) │
                    └───────────────┘
```

### State Model (Intent/Reality)

All four entity types share the same seven-state model. States are divided into phases that track the gap between what you intend to build and what actually exists in the codebase.

| State | Phase | Codebase signal |
|-------|-------|-----------------|
| `planning` | Pre-intent | No code exists |
| `creating` | Intent | Code may be partially written |
| `created` | Reality | Code exists and is current |
| `updating` | Intent | Code exists but needs changes |
| `deleting` | Intent | Code exists and needs removal |
| `deleted` | Reality | Code was removed |
| `discarded` | Terminal | No code was ever written |

New entities start in `planning`. The default `et list` view excludes `deleted` and `discarded` items. Use `--all` to include them.

### State Transitions

```
                  et approve             et close
  planning ───────────────▶ creating ──────────▶ created
     │                         │                    │
     │ et discard              │ et remove          │ et update / et reopen
     ▼                         ▼                    ▼
  discarded               deleting              updating
                              │                    │
                              │ et remove          │ et close
                              ▼                    │
                           deleted ◀───────────────┘
                                        et remove
```

**Key transitions:**

| From | To | Trigger |
|------|----|---------|
| `planning` | `creating` | `et approve <type> <id>` |
| `planning` | `discarded` | `et discard <type> <id>` |
| `creating` | `created` | `et close <type> <id>` |
| `creating` | `deleting` | `et remove <type> <id>` |
| `created` | `updating` | `et update <type> <id> ...` (automatic) or `et reopen <type> <id>` |
| `created` | `deleting` | `et remove <type> <id>` |
| `updating` | `created` | `et close <type> <id>` |
| `updating` | `deleting` | `et remove <type> <id>` |
| `deleting` | `deleted` | `et remove <type> <id>` (second call) |

**Terminal states:** `deleted` and `discarded` have no transitions out.

**Blocked operations:** `et update` is blocked on entities in `deleting`, `deleted`, or `discarded` states.

### Codebase Audit Guide

Use entity states to audit alignment between the screenplay model and the codebase:

| State | What to check |
|-------|---------------|
| `planning` | Nothing in the codebase yet. Review the entity description for clarity before approving. |
| `creating` | Code should be in progress. Look for partial implementations, feature branches, or scaffolding. |
| `created` | Code should exist and be current. Verify the implementation matches the entity description. |
| `updating` | Code exists but needs changes. Look for the gap between current code and the updated entity description. |
| `deleting` | Code exists and needs removal. Identify what to delete, clean up references, then confirm removal. |
| `deleted` | Code was removed. Verify no dead code or dangling references remain. |
| `discarded` | No code was ever written. Nothing to check. |

## Actor

An actor represents a user role in the system. Actors are the real people who use your product.

### Fields

| Field | Required | Type | Description |
|-------|----------|------|-------------|
| `id` | Yes | string | Unique identifier (alphanumeric, underscores, hyphens) |
| `name` | Yes | string | Human-readable name |
| `description` | Yes | string | Brief description of the role and their needs |
| `goals` | No | string[] | Goal IDs this actor wants to achieve |
| `tags` | No | string[] | Labels for filtering and categorisation |
| `meta` | No | object | Custom key-value metadata |
| `state` | Auto | See [State Model](#state-model-intentreality) | Default: `planning` |
| `created_at` | Auto | ISO date | Creation timestamp |
| `updated_at` | Auto | ISO date | Last update timestamp |

### Relationships

- **Has goals** - Listed in the `goals` field
- **Referenced by interactions** - Via `performed_by` field
- **Referenced by journeys** - Via `actor` field (as protagonist)

### Validation Rules

| Check | Severity | Description |
|-------|----------|-------------|
| Goals exist | Error | All goal IDs in `goals` field must reference existing goals |
| Has goals | Warning | Actor without any goals assigned |

### Best Practices

**Do:** Create distinct roles representing real users with different needs (e.g., `free_user`, `premium_user`).

**Don't:** Create actors for internal roles (developer, QA) unless your product IS for those people.

**Exception:** Tools built for developers (like `et` itself) can have developer actors. The actor `team_member` is valid for a project management tool.

## Goal

A goal represents what a user wants to achieve. Goals are **always** user goals, never project goals, team objectives, or technical milestones.

### Fields

| Field | Required | Type | Description |
|-------|----------|------|-------------|
| `id` | Yes | string | Unique identifier |
| `name` | No | string | Human-friendly display name (defaults to `id`) |
| `description` | Yes | string | What the user wants to achieve |
| `actor` | No* | string | Actor who has this goal |
| `success_criteria` | No | string | How we know the goal is achieved |
| `state` | Auto | See [State Model](#state-model-intentreality) | Default: `planning` |
| `tags` | No | string[] | Labels for filtering |
| `meta` | No | object | Custom key-value metadata |
| `created_at` | Auto | ISO date | Creation timestamp |
| `updated_at` | Auto | ISO date | Last update timestamp |

*Goals without actors are flagged as warnings by validation.

### Relationships

- **Belongs to actor** - Via `actor` field
- **Supported by interactions** - Interactions reference this goal
- **Achieved by journeys** - Journeys reference this goal

### Validation Rules

| Check | Severity | Description |
|-------|----------|-------------|
| Actor exists | Error | Referenced actor must exist |
| Has actor | Warning | Orphan goal (not linked to any actor) |
| Has interactions | Warning | Goal with no supporting interactions |

### Good vs Bad Goals

| Bad (Project-Focused) | Good (User-Focused) |
|----------------------|---------------------|
| "Implement OAuth" | "Log in securely without remembering passwords" |
| "Add caching layer" | "Experience fast, responsive page loads" |
| "Increase test coverage" | "Trust that the service works reliably" |
| "Refactor checkout" | "Complete purchase quickly and confidently" |

### Writing Effective Goals

1. Write from the user's perspective: "I want to..." not "We need to..."
2. Focus on outcomes: What state does the user want to reach?
3. Be specific but not technical: Users do not care about implementation
4. Include success criteria: How will the user know they succeeded?

## Interaction

An interaction represents a task or action that helps a user reach their goal. This is the "how" of the Screenplay Pattern.

### Fields

| Field | Required | Type | Description |
|-------|----------|------|-------------|
| `id` | Yes | string | Unique identifier |
| `name` | No | string | Human-friendly display name (defaults to `id`) |
| `description` | Yes | string | What the interaction accomplishes |
| `performed_by` | No | string | Actor performing this action (defaults to "developer") |
| `goal` | No* | string | Single goal this interaction supports (backward compatible) |
| `goals` | No* | string[] | Multiple goal IDs this interaction supports |
| `priority` | No | integer | Priority level (0 = highest). Lower numbers = higher priority. Null means unprioritized |
| `state` | Auto | See [State Model](#state-model-intentreality) | Default: `planning` |
| `tags` | No | string[] | Labels for filtering |
| `meta` | No | object | Custom key-value metadata |
| `created_at` | Auto | ISO date | Creation timestamp |
| `updated_at` | Auto | ISO date | Last update timestamp |

*Use `--goal` for a single goal or `--goals` for multiple. If both provided, `--goals` takes precedence. Interactions without goals are flagged as warnings by validation.

### Relationships

- **Performed by actor** - Via `performed_by` field
- **Supports goal(s)** - Via `goal` or `goals` field
- **Used in journeys** - Referenced as steps in journey's `steps` field

### Validation Rules

| Check | Severity | Description |
|-------|----------|-------------|
| Goal(s) exist | Error | All referenced goals must exist |
| Performed_by exists | Error | Referenced actor must exist |
| Has goal | Warning | Interaction not linked to any goal |

### Multi-Goal Interactions

Some interactions naturally support multiple goals:

```bash
# Export feature supports both data access and compliance goals
et create interaction --id "export_data" \
  --description "Export data in standard formats" \
  --performed-by "admin" \
  --goals "data_access,compliance_reporting" --json
```

## Journey

A journey ties together an Actor, a Goal, and a sequence of Interactions into a complete user story. It is the "script" for how a user achieves their goal.

### Fields

| Field | Required | Type | Description |
|-------|----------|------|-------------|
| `id` | Yes | string | Unique identifier |
| `actor` | Yes | string | Protagonist (who benefits from completing this journey) |
| `goal` | Yes | string | Goal achieved at journey's end |
| `steps` | Yes | string[] | Interaction IDs in order |
| `narrative` | No | string | Human-readable description of the flow |
| `tags` | No | string[] | Labels for filtering |
| `meta` | No | object | Custom key-value metadata |
| `state` | Auto | See [State Model](#state-model-intentreality) | Default: `planning` |
| `created_at` | Auto | ISO date | Creation timestamp |
| `updated_at` | Auto | ISO date | Last update timestamp |

### Relationships

- **Has protagonist** - The `actor` field (who benefits)
- **Achieves goal** - The `goal` field
- **Contains steps** - Ordered interaction IDs in `steps` field

### Journey Actors vs Step Actors

The journey's `actor` is the **protagonist** (who benefits), not necessarily who performs every step.

```bash
# Customer is protagonist (they benefit)
# But support_agent_investigates is performed BY the support agent
et create journey --id "support_flow" \
  --actor "customer" \
  --goal "get_issue_resolved" \
  --steps "submit_ticket,support_agent_investigates,provide_solution" --json
```

This reflects reality: the customer's goal matters most, even though achieving it requires work by multiple people.

### Validation Rules

| Check | Severity | Description |
|-------|----------|-------------|
| Actor exists | Error | Referenced actor must exist |
| Goal exists | Error | Referenced goal must exist |
| All steps exist | Error | Every interaction ID must exist |
| Goal belongs to actor | Warning | Goal's actor should match journey's actor |
| Steps match actor | Warning | Steps performed by different actor than journey actor |

### Multiple Journeys Per Goal

A goal can be achieved via different journeys:

```bash
# Quick checkout for returning customers
et create journey --id "quick_checkout" --actor "customer" --goal "complete_purchase" \
  --steps "quick_buy,express_checkout,receive_confirmation" --json

# Full checkout for new customers
et create journey --id "full_checkout" --actor "customer" --goal "complete_purchase" \
  --steps "browse,add_to_cart,view_cart,checkout,receive_confirmation" --json
```

## Tags

Tags categorise entities for filtering and organisation.

### Operations

| CLI Option | Behaviour |
|------------|-----------|
| `--tags <tag1,tag2>` | Replace all tags (create or update) |
| `--add-tags <tag1,tag2>` | Add to existing tags (update only) |
| `--remove-tags <tag1,tag2>` | Remove specific tags (update only) |
| `--tag <tag1,tag2>` | Filter by tags in list commands (OR matching) |

### Common Tag Patterns

| Pattern | Tags | Purpose |
|---------|------|---------|
| Verification status | `verified`, `unverified` | Track what has been confirmed against the real system |
| Source tracking | `legacy`, `new`, `both` | Track where functionality exists during migration |
| Priority | `critical`, `priority` | Flag important items |
| Documentation | `documented`, `needs-review` | Track documentation state |

## Metadata

Metadata stores arbitrary key-value pairs on any entity.

### Operations

| CLI Option | Behaviour |
|------------|-----------|
| `--meta key=value` | Add or update entry (repeatable for multiple keys) |
| `--meta-json '{"key":"value"}'` | Add or update via JSON object |
| `--remove-meta key` | Remove a key (repeatable, update only) |

### Querying Metadata

Metadata is included in JSON output. Use `jq` for filtering:

```bash
et list interactions --format json | jq '.[] | select(.meta.priority == "high")'
```

### Common Metadata Patterns

| Key | Purpose | Example |
|-----|---------|---------|
| `source` | Where this entity was discovered | `source=legacy_app` |
| `discovered_in` | UI location where found | `discovered_in=admin_panel` |
| `login_hint` | Credentials for testing | `login_hint=admin@example.com` |
| `last_verified` | When last confirmed | `last_verified=2024-01-15` |
| `variant_of` | Parent journey for variants | `variant_of=checkout_flow` |
