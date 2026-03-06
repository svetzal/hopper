All done. Here is a summary of every change made and the reasoning behind each decision.

---

## What was done

### New files

| File | What it is |
|---|---|
| `src/extract-result.ts` | Pure function that parses a Claude JSONL stream to find the `result` line. Previously buried inside `worker.ts` with no tests. |
| `src/extract-result.test.ts` | 8 tests covering the happy path, multiple result lines, no result line, empty input, mixed bad JSON, non-string result fields, and CRLF line endings. |
| `src/worker-workflow.ts` | 6 pure, side-effect-free functions that encode every decision the worker makes: where to run work (`resolveWorkSetup`), what to say to Claude (`buildTaskPrompt`, `buildAutoCommitPrompt`), whether to auto-commit (`resolvePostClaudeAction`), whether to merge (`resolveMergeAction`), and whether to complete or leave for manual requeue (`resolveCompletionAction`). Plus `resolveAuditPaths` for path computation. |
| `src/worker-workflow.test.ts` | 30 tests, one per decision branch, all pure and sub-millisecond fast. |
| `src/gateways/git-gateway.ts` | `GitGateway` interface + real implementation. The git subprocess logic moved verbatim from `worker.ts` — no logic changes, just relocated and wrapped behind an interface. |
| `src/gateways/claude-gateway.ts` | `ClaudeGateway` interface + real implementation. The `spawnClaude` function moved verbatim, now importing `extractResult` from its new home. |
| `src/gateways/fs-gateway.ts` | `FsGateway` interface + real implementation for `ensureDir` and `writeFile`. |

### Modified files

| File | What changed |
|---|---|
| `src/commands/worker.ts` | **Complete rewrite** as the imperative shell. Same observable behaviour — identical console output, identical store interactions — but every *decision* is now delegated to a pure function and every *I/O call* goes through a gateway. The function signature gains an optional `deps` parameter so tests can inject mocks without touching the call-site in `cli.ts`. |
| `AGENTS.md` | Source layout table extended with the new files; a Gateway pattern entry added to Key Patterns. |

### What did not change

`cli.ts`, `store.ts`, `format.ts`, `titler.ts`, and all other command files are untouched. The CLI interface, `--json` output, and the binary are identical from the user's perspective.

### Test count
**48 → 86** (+38 tests, all green, zero warnings).

### Suggested commit message
```
Extract functional core from worker: gateways + pure workflow functions

The worker command was a 277-line untested imperative monolith. Split it into:
- Pure decision functions in src/worker-workflow.ts (fully tested)
- A pure JSONL parser in src/extract-result.ts (fully tested)
- Thin I/O gateways for git, claude, and fs (untested by design)
- A lean imperative shell in src/commands/worker.ts that wires them together

38 new tests added; all 86 pass; zero type errors; binary unchanged.
```