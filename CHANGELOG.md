# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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

[Unreleased]: https://github.com/svetzal/hopper/compare/v0.3.2...HEAD
[0.3.2]: https://github.com/svetzal/hopper/compare/v0.3.1...v0.3.2
[0.3.1]: https://github.com/svetzal/hopper/compare/v0.3.0...v0.3.1
[0.3.0]: https://github.com/svetzal/hopper/compare/v0.2.1...v0.3.0
[0.2.1]: https://github.com/svetzal/hopper/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/svetzal/hopper/compare/v0.1.1...v0.2.0
[0.1.1]: https://github.com/svetzal/hopper/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/svetzal/hopper/releases/tag/v0.1.0
