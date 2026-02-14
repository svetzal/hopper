<!-- et v0.9.0 -->
# CLI Reference

Complete reference for all `et` commands, flags, and options.

## Global Options

| Flag | Purpose |
|------|---------|
| `--json` | Output in JSON format (always use for agent interactions) |
| `--format json\|table` | Explicit output format selection |
| `--verbose` | Show detailed output |
| `--quiet` | Suppress non-essential output |
| `--help` | Show help message |
| `--version` | Show version number |

### State Filtering (list commands)

| Flag | Behaviour |
|------|-----------|
| *(default)* | Show active items (excludes `deleted` and `discarded`) |
| `--state <state>` | Show only items in the specified state |
| `--all` | Show all items regardless of state |

### Tag Filtering (list commands)

```bash
--tag <tags>    # Comma-separated, OR matching
```

## Create Commands

### Create Actor

```bash
et create actor --id <id> --name "<name>" --description "<description>" [options] --json
```

| Option | Required | Description |
|--------|----------|-------------|
| `--id` | Yes | Unique identifier |
| `--name` | Yes | Human-readable name |
| `--description` | Yes | Description of the actor's role and needs |
| `--goals` | No | Comma-separated goal IDs |
| `--tags` | No | Comma-separated tags |
| `--meta` | No | Metadata entry as `key=value` (repeatable) |
| `--meta-json` | No | Metadata as JSON object |

### Create Goal

```bash
et create goal --id <id> --description "<description>" [options] --json
```

| Option | Required | Description |
|--------|----------|-------------|
| `--id` | Yes | Unique identifier |
| `--description` | Yes | What the user wants to achieve |
| `--name` | No | Human-friendly display name (defaults to id) |
| `--actor` | No* | Actor who has this goal |
| `--success-criteria` | No | How we know the goal is achieved |
| `--tags` | No | Comma-separated tags |
| `--meta` | No | Metadata entry as `key=value` (repeatable) |
| `--meta-json` | No | Metadata as JSON object |

*Goals without actors are flagged as warnings by `et validate`.

### Create Interaction

```bash
et create interaction --id <id> --description "<description>" [options] --json
```

| Option | Required | Description |
|--------|----------|-------------|
| `--id` | Yes | Unique identifier |
| `--description` | Yes | What the interaction accomplishes |
| `--name` | No | Human-friendly display name (defaults to id) |
| `--performed-by` | No | Actor performing this action (defaults to "developer") |
| `--goal` | No* | Single goal this interaction supports |
| `--goals` | No* | Comma-separated goal IDs (multiple goals) |
| `--priority` | No | Priority level (integer, 0 = highest). Lower numbers = higher priority |
| `--tags` | No | Comma-separated tags |
| `--meta` | No | Metadata entry as `key=value` (repeatable) |
| `--meta-json` | No | Metadata as JSON object |

*Use `--goal` for a single goal or `--goals` for multiple. If both provided, `--goals` takes precedence. Interactions without goals are flagged as warnings by `et validate`.

### Create Journey

```bash
et create journey --id <id> --actor <actor_id> --goal <goal_id> --steps <step1,step2,...> [options] --json
```

| Option | Required | Description |
|--------|----------|-------------|
| `--id` | Yes | Unique identifier |
| `--actor` | Yes | Protagonist (who benefits from completing this journey) |
| `--goal` | Yes | Goal achieved at journey's end |
| `--steps` | Yes | Comma-separated interaction IDs in order |
| `--narrative` | No | Human-readable description of the flow |
| `--tags` | No | Comma-separated tags |
| `--meta` | No | Metadata entry as `key=value` (repeatable) |
| `--meta-json` | No | Metadata as JSON object |

## List Commands

### Tree View (no type specified)

```bash
et list [--json] [--state <state>] [--all] [--tag <tags>]
```

Shows hierarchical view: Actors -> Goals -> Interactions. Orphan goals and standalone interactions appear in special groups.

### List by Type

```bash
et list actors [--format json] [--state <state>] [--all] [--tag <tags>]
et list goals [--format json] [--actor <id>] [--state <state>] [--all] [--tag <tags>]
et list interactions [--format json] [--goal <id>] [--state <state>] [--all] [--tag <tags>]
et list journeys [--format json] [--actor <id>] [--goal <id>] [--state <state>] [--all] [--tag <tags>]
```

### JSON Output Structure (Tree View)

```json
[
  {
    "type": "actor",
    "id": "customer",
    "description": "Customer",
    "tags": ["external"],
    "children": [
      {
        "type": "goal",
        "id": "checkout",
        "description": "Complete purchase successfully",
        "state": "creating",
        "tags": ["verified"],
        "children": [
          {
            "type": "interaction",
            "id": "add_to_cart",
            "description": "Add products to cart",
            "state": "planning"
          }
        ]
      }
    ]
  }
]
```

## Show Commands

```bash
et show actor <id> [--json]
et show goal <id> [--json]
et show interaction <id> [--json]
et show journey <id> [--json]
```

Returns full entity data including all fields, tags, metadata, and timestamps.

### JSON Output Example

```json
{
  "id": "complete_purchase",
  "description": "Successfully purchase products",
  "actor": "customer",
  "success_criteria": "Order confirmed, payment processed",
  "state": "creating",
  "tags": ["verified"],
  "meta": {"source": "discovery"},
  "created_at": "2024-01-15T10:30:00.000Z",
  "updated_at": "2024-01-15T10:30:00.000Z"
}
```

## Update Commands

**State behaviour:** Running `et update` on an entity in the `created` state automatically transitions it to `updating`. Updates are blocked on entities in `deleting`, `deleted`, or `discarded` states.

### Common Tag and Metadata Options (All Entity Types)

| Option | Description |
|--------|-------------|
| `--tags <tag1,tag2>` | Replace all tags with this list |
| `--add-tags <tag1,tag2>` | Add tags to existing |
| `--remove-tags <tag1,tag2>` | Remove specific tags |
| `--meta key=value` | Add/update metadata entry (repeatable) |
| `--meta-json '{"key":"value"}'` | Add/update metadata via JSON |
| `--remove-meta key` | Remove metadata key (repeatable) |

### Update Actor

```bash
et update actor <id> [--name "<name>"] [--description "<desc>"] [--goals <goal1,goal2>] [tag/meta options] --json
```

### Update Goal

```bash
et update goal <id> [--name "<name>"] [--description "<desc>"] [--actor <actor>] [--success-criteria "<criteria>"] [tag/meta options] --json
```

### Update Interaction

```bash
et update interaction <id> [--name "<name>"] [--description "<desc>"] [--performed-by <actor>] [--goal <goal>] [--goals <goal1,goal2>] [--priority <n>] [tag/meta options] --json
```

### Update Journey

```bash
et update journey <id> [--actor <actor>] [--goal <goal>] [--steps <step1,step2>] [--narrative "<narrative>"] [tag/meta options] --json
```

## Remove Commands

```bash
et remove actor <id> [--force] --json
et remove goal <id> [--force] --json
et remove interaction <id> [--force] --json
et remove journey <id> [--force] --json
```

Remove uses a **two-step** process:

1. **First call** transitions the entity to `deleting` (intent to delete). This signals that the corresponding code should be removed.
2. **Second call** transitions the entity to `deleted` (reality confirmed). Use this after the code has been cleaned up.

### Reference Checking

Before removing, `et` checks if the entity is referenced by other entities:

- **Actors** referenced by: goals, interactions (performed_by), journeys
- **Goals** referenced by: actors (goals list), interactions, journeys
- **Interactions** referenced by: journeys (steps)
- **Journeys** not referenced by other entities

If references exist and `--force` is not used, removal is blocked:

```json
{
  "success": false,
  "error": "Entity is referenced by other entities",
  "references": [
    {"type": "goal", "id": "checkout", "field": "actor"},
    {"type": "interaction", "id": "add_to_cart", "field": "performed_by"}
  ],
  "hint": "Use --force to remove anyway"
}
```

**Warning:** Force removing leaves dangling references. Run `et validate` afterwards.

## Approve and Discard Commands

```bash
et approve <type> <id> [--json]
et discard <type> <id> [--json]
```

- `et approve` transitions an entity from `planning` to `creating`. This signals intent to build.
- `et discard` transitions an entity from `planning` to `discarded`. Use this when a planned entity is no longer needed and no code was ever written.
- Both commands work on all four entity types.

## Close and Reopen Commands

```bash
et close <type> <id> [--json]
et reopen <type> <id> [--json]
```

- `et close` works on **all four entity types**. It transitions `creating` to `created`, or `updating` to `created`.
- `et reopen` works on **all four entity types**. It transitions `created` to `updating`.
- If already in the target state, the command succeeds without error.
- All entity types share the same seven-state model. See [Entity Model](entity-model.md) for the full state machine.

## Validate Command

```bash
et validate [--json]
```

### What Gets Checked

| Entity | Errors (Must Fix) | Warnings (Should Review) |
|--------|-------------------|--------------------------|
| Actor | Referenced goals exist | Has at least one goal |
| Goal | Referenced actor exists | Has actor assigned; has supporting interactions |
| Interaction | Referenced goal(s) exist; performed_by actor exists | Has goal assigned |
| Journey | Actor, goal, all steps exist | Goal belongs to journey's actor; steps performed by journey's actor |

### JSON Output

```json
{
  "valid": false,
  "issues": [
    {"type": "error", "entity": "goal", "id": "checkout", "message": "References non-existent actor 'missing'"},
    {"type": "warning", "entity": "interaction", "id": "orphan", "message": "Interaction is not linked to any goal"}
  ],
  "summary": {
    "actors": 2, "goals": 6, "interactions": 7, "journeys": 1,
    "errors": 1, "warnings": 1
  }
}
```

### Exit Codes

| Code | Meaning |
|------|---------|
| 0 | Valid (no errors; warnings may exist) |
| 1 | Invalid (one or more errors) |

## Init Command

Install AI agent skill files into your project.

```bash
et init [--json]
```

Installs or updates 5 skill files in `.claude/skills/epilogue-tracker/`:

| File | Purpose |
|------|---------|
| `SKILL.md` | Main skill entry point with philosophy, setup, and workflow |
| `references/cli-reference.md` | Complete CLI command reference |
| `references/entity-model.md` | Entity types, fields, and relationships |
| `workflows/getting-started.md` | Step-by-step project bootstrap guide |
| `workflows/breaking-down-work.md` | How to decompose features, bugs, and tech debt |

Each file is stamped with the `et` version. Running `init` again after upgrading updates the files.

### JSON Output

```json
{
  "success": true,
  "message": "Skill files installed: 5 created",
  "version": "0.8.3",
  "files": [
    { "path": ".claude/skills/epilogue-tracker/SKILL.md", "action": "created" }
  ]
}
```

File actions: `created` (new), `updated` (content changed), `up-to-date` (no changes needed).

## Migrate Command

Upload local `.et/` data to a remote server. Used for one-time migration of legacy local data.

```bash
et migrate [--dry-run] [--json]
et migrate --server <url> --token <token> [--dry-run] [--json]
```

- Configuration read from `.et_env` (ET_API_HOST, ET_API_TOKEN)
- `--server` and `--token` flags override `.et_env` values
- Migration order: Actors -> Goals -> Interactions -> Journeys (respects dependencies)
- State preserved: closed goals/interactions are closed on the server after creation
- `--dry-run` previews without uploading

## Generate Documentation

```bash
et docs --agents [--output <file>]
```

Generates agent onboarding documentation for projects using `et`.

## Jam Command

```bash
et jam
```

Opens an interactive chat session where you discuss your product with an LLM. The LLM understands the Screenplay Pattern and has tools to read and modify screenplay entities (actors, goals, interactions, journeys). It will confirm before making changes. Responses stream to the terminal in real time.

### Prerequisites

| Variable | Required | Description |
|----------|----------|-------------|
| `OPENAI_API_KEY` | Yes | Set in `.et_env` or as an environment variable |
| `ET_LLM_MODEL` | No | LLM model to use (defaults to `gpt-4o`) |

### Session Commands

| Command | Purpose |
|---------|---------|
| `/quit` | End the session |
| `/exit` | End the session |

## Standard JSON Response Format

### Success

```json
{
  "success": true,
  "message": "Actor 'customer' created",
  "data": { /* full entity data */ }
}
```

### Error

```json
{
  "success": false,
  "error": "Entity with ID 'customer' already exists"
}
```

## ID Format Rules

- Letters, numbers, underscores, and hyphens only
- 1-100 characters
- No path separators or ".."
