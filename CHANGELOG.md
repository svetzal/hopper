# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Coordinator skill now includes 'Investigating In-Progress Tasks' section with audit log diagnosis, process inspection, failure mode taxonomy, and decision flow for stuck tasks

### Changed

- Coordinator skill now includes guidance on naming craftsperson subagents in work item descriptions for stack-specific engineering standards
- Revise failure-mode guidance: remove speculative frequency-ranked table, replace with signal-based bullet list

## [1.5.2] - 2026-04-11

### Fixed

- Git tags created by workers in worktrees are now pushed to the remote after merge

### Changed

- Standardized release process documentation in AGENTS.md

## [1.5.1] - 2026-04-11

### Fixed

- Fix git spawn ENOENT error in worker when invoking git subprocesses

## [1.5.0] - 2026-04-11

### Added

- Directory-aware parallel claiming — `claimNext` automatically serializes items that target the same or overlapping `workingDir`, including parent/child containment detection (e.g., `/repo` and `/repo/subproject` serialize, but `/repo/a` and `/repo/b` run in parallel)
- Items without an explicit `workingDir` use the process CWD as their effective directory for serialization

### Changed

- Default worker concurrency bumped from 1 to 4 — safe because same-directory work is now automatically serialized
- Coordinator skill no longer requires manual `--after-item` chaining for conflict prevention; `--after-item` is now only needed for logical dependencies or explicit ordering

## [1.4.0] - 2026-03-28

### Changed

- Worker task prompt now instructs agents to follow analyze → plan → execute → validate phases, requiring tests and linter to pass before declaring work done
- Coordinator skill adds validation criteria guidance, recommended description structure (Context / Work / Validation), and updated examples that consistently include validation requirements

## [1.3.0] - 2026-03-25

### Fixed

- Automatic merge-back now works for newly created target branches — previously skipped with "target branch not checked out" when the branch didn't exist before the worker created it

### Changed

- Extracted git workflow decisions (branch setup, merge steps) to pure functions in `git-workflow.ts`
- Extracted add command logic to functional core in `add-workflow.ts`

### Maintenance

- Upgraded TypeScript to 6.0.2
- Updated @types/bun to 1.3.11
- Added local installation instructions to AGENTS.md

## [1.2.1] - 2026-03-17

### Added

- Version guard on `hopper init` — refuses to overwrite a newer skill with an older binary unless `--force` is used
- `--force` flag for `hopper init` to bypass version guard
- Skill Distribution section in AGENTS.md documenting the init workflow

## [1.2.0] - 2026-03-17

### Added

- `--times <n>` flag for `add` command to limit the number of recurrences when used with `--every`
- Worker auto-pushes to origin after successful merge of work branch

## [1.1.0] - 2026-03-17

### Added

- Arbitrary shell command support via `--command` flag on `add` and `preset add` — worker runs the command via `sh -c` instead of spawning Claude
- Shell gateway (`src/gateways/shell-gateway.ts`) for command execution with stdout/stderr capture and audit logging
- `--dir` without `--branch` is now valid when `--command` is set (runs command in that directory without worktree)
- `command` field displayed in `show`, `preset show`, and `preset list` output

## [1.0.2] - 2026-03-07

### Changed

- Document release process in AGENTS.md

## [1.0.1] - 2026-03-07

### Fixed

- Worker now exits immediately on Ctrl-C when idle (poll sleep is cancelled on shutdown)

## [1.0.0] - 2026-03-07

### Added

- Recurring items with `--every` flag (e.g. `--every 2h`, `--every 1d`) — completed items automatically re-queue on schedule
- Scheduling and duration parsing support for recurring intervals
- Concurrent worker support with `--concurrency` flag to process multiple items in parallel
- Preset/template commands (`preset add`, `preset list`, `preset use`) for reusable work items
- Item priorities with `--priority` flag (`low`, `medium`, `high`, `critical`) and priority-based queue sorting
- Item dependencies with `--after-item` flag — dependent items show `blocked` status until their prerequisite completes
- Tagging system with `--tag` flag on `add` and `--tag` filter on `list`
- `--global` flag on `init` to install skills to `~/.claude/skills/` for system-wide availability

### Changed

- Worker now commits on Claude's behalf using the item title and Claude's summary as the commit message, instead of running a separate auto-commit Claude session
- Task prompt tells Claude not to commit — Hopper handles all git operations
- Updated coordinator skill with comprehensive CLI coverage

## [0.5.0] - 2026-03-06

### Changed

- Rewrote hopper-coordinator skill to focus on dispatching concrete work to background agents, with guardrails against misuse as a to-do list
- Made `--dir`/`--branch` the primary usage pattern in coordinator skill docs and examples

### Removed

- hopper-worker skill (superseded by `hopper worker` command)
- `hopper init` now removes the deprecated worker skill from target projects

## [0.4.3] - 2026-03-04

### Fixed

- Worktree setup when the target branch doesn't yet exist

## [0.4.2] - 2026-03-03

### Fixed

- Robust worktree handling with auto-commit and merge-back in hopper worker
- Worktree add when branch is already checked out elsewhere

## [0.4.0] - 2026-03-03

### Added

- `hopper worker` command — runs the claim/work/complete cycle with isolated git worktrees, replacing `claude_worker.sh`
- `--branch` flag on `add` command (required with `--dir`) for worktree-based isolation
- Audit logging to `~/.hopper/audit/`

### Removed

- `claude_worker.sh` script (replaced by `hopper worker`)

### Changed

- Updated dependencies to latest versions

## [0.3.3] - 2026-02-24

### Changed

- Extract `resolveItem` helper to eliminate duplicated ID resolution logic
- Move audit logs to dedicated directory
- Update workspace paths
- Update transitive dependencies

## [0.3.2] - 2026-02-16

### Added

- MIT license
- `src/constants.ts` as single source of truth for VERSION and item status constants

### Changed

- Extract item status literals into `Status` const object, replacing ~20 scattered string literals
- Extract fallback title truncation length into named constant in titler
- Consolidate VERSION declaration — single definition in `constants.ts`, eliminating circular dependency between `cli.ts` and `init.ts`
- Remove openclaw notification from claude_worker script after completing Claude session

## [0.3.1] - 2026-02-14

### Added

- SKILL.md files for hopper-coordinator and hopper-worker skills
- AGENTS.md for project guidance

## [0.3.0] - 2026-02-14

### Added

- `--dir` flag for specifying task working directory
- `--result` flag on `complete` command for recording task outcomes
- `init` command to install skill files into target repositories
- `show` command to display full item details
- `cancel` command to cancel in-progress items
- `claude_worker.sh` script to orchestrate the claim-work-complete cycle with Claude
- SKILL.md for writing cross-agent compatible skills
- Pre-push git hook to run lint and tests before pushing
- Skill file embedding via Bun text imports at build time

### Changed

- `list` command now shows claim tokens for in-progress items
- `add` command now outputs item ID after creation

## [0.2.1] - 2026-02-14

### Fixed

- TypeScript strict null check in requeue prefix matching

## [0.2.0] - 2026-02-14

### Added

- Claim lifecycle: `claim`, `complete`, and `requeue` commands
- Claim tokens (UUID) to prevent completing items you didn't claim
- ID prefix matching for `claim`, `complete`, `requeue`, and `cancel` commands

## [0.1.1] - 2026-02-14

### Changed

- Replace Mojentic dependency with direct OpenAI API call for title generation (zero runtime dependencies)

## [0.1.0] - 2026-02-14

### Added

- Initial implementation of hopper CLI
- `add` command to queue new work items with LLM-generated titles
- `list` command to display queued, in-progress, and completed items
- `next` command to dequeue the next item
- JSON file storage at `~/.hopper/items.json`
- `--json` flag for machine-readable output on all commands
- Cross-platform build targets (macOS, Linux, Windows)

### Fixed

- Release workflow: use macos-14 for x64 builds

[Unreleased]: https://github.com/svetzal/hopper/compare/v1.5.2...HEAD
[1.5.2]: https://github.com/svetzal/hopper/compare/v1.5.1...v1.5.2
[1.5.1]: https://github.com/svetzal/hopper/compare/v1.5.0...v1.5.1
[1.1.0]: https://github.com/svetzal/hopper/compare/v1.0.2...v1.1.0
[1.0.0]: https://github.com/svetzal/hopper/compare/v0.5.0...v1.0.0
[0.5.0]: https://github.com/svetzal/hopper/compare/v0.4.3...v0.5.0
[0.4.3]: https://github.com/svetzal/hopper/compare/v0.4.2...v0.4.3
[0.4.2]: https://github.com/svetzal/hopper/compare/v0.4.0...v0.4.2
[0.4.0]: https://github.com/svetzal/hopper/compare/v0.3.3...v0.4.0
[0.3.3]: https://github.com/svetzal/hopper/compare/v0.3.2...v0.3.3
[0.3.2]: https://github.com/svetzal/hopper/compare/v0.3.1...v0.3.2
[0.3.1]: https://github.com/svetzal/hopper/compare/v0.3.0...v0.3.1
[0.3.0]: https://github.com/svetzal/hopper/compare/v0.2.1...v0.3.0
[0.2.1]: https://github.com/svetzal/hopper/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/svetzal/hopper/compare/v0.1.1...v0.2.0
[0.1.1]: https://github.com/svetzal/hopper/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/svetzal/hopper/releases/tag/v0.1.0
