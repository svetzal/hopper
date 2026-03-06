```json
{ "severity": 3, "principle": "Functional Core, Imperative Shell", "category": "Architecture" }
```

## Assessment

After reviewing the full codebase, the project is **remarkably well-built** for its scope. It has zero dependencies, clean module boundaries, solid tests on the core store and format logic, and clear intent in naming. The CHARTER and AGENTS.md are exemplary. Most of my principles are well-served here. But one stands out as the most significant violation:

## Primary Violation: Functional Core, Imperative Shell — `worker.ts` is a 277-line imperative monolith with no tests

The `worker.ts` file is by far the most complex file in the project (~277 lines) and it has **zero test coverage**. It contains the most critical workflow logic — the claim-work-complete cycle — yet it is entirely untestable in its current form because pure business logic is deeply entangled with I/O (spawning git processes, spawning Claude, writing audit files, reading worktree state).

### What's entangled

The file mixes several concerns into one untested blob:

1. **Git worktree orchestration** — `gitWorktreeAdd`, `gitWorktreeRemove`, `isWorktreeDirty`, `gitMergeWorkBranch` are all gateway functions that directly call `Bun.spawn`. They contain non-trivial branching logic (checking local vs remote branches, trying fast-forward then merge then abort) that is **impossible to test without running real git commands**.

2. **Claude session management** — `spawnClaude` mixes process spawning with audit file writing. `extractResult` is a pure function buried inside an untestable file.

3. **Workflow orchestration** — The `workerCommand` function itself contains the state machine logic (claim → worktree setup → claude run → auto-commit → merge → complete/requeue) as inline imperative code with deeply nested conditionals.

### How to correct it

**Extract the pure core:**

- **`extractResult`** is already pure — move it to its own module (or `format.ts`) and test it independently. It parses JSONL, which is non-trivial and currently untested.

- **The workflow state machine** (what happens after claiming, when to auto-commit, when to merge, what constitutes success) should be a pure function that takes inputs (item, claude exit code, worktree dirty status, merge outcome) and returns decisions (what to do next). Test the decisions, not the I/O.

- **`gitMergeWorkBranch`'s decision logic** (fast-forward → merge → abort → preserve) is a meaningful state machine hidden inside process spawning. Extract the decision sequence from the subprocess calls.

**Wrap I/O in thin gateways:**

- Create a `GitGateway` interface with methods like `worktreeAdd`, `worktreeRemove`, `isDirty`, `merge`. The real implementation calls `Bun.spawn`; tests inject a mock.
- Create a `ClaudeGateway` for process spawning.
- These gateways should be **thin wrappers** with no logic to test.

**Resulting structure:**
```
workerWorkflow(item, gitGateway, claudeGateway) → decisions/actions
```

This would make the most complex and critical part of the system testable, while keeping the current simplicity of the simpler commands.

### Secondary observations (lower severity)

- **Titler tests don't test the real `createTitleGenerator`** — they test hand-crafted doubles that don't exercise the fallback path of the actual factory function. The `createTitleGenerator` function reads `process.env` directly (should be injected) and calls `fetch` directly (should go through a gateway). At minimum, the no-API-key fallback path is pure and testable.
- **Module-level mutable state** in `store.ts` (`let storeDir`) — `setStoreDir` is global mutable state that makes tests order-dependent. Passing a store path as a parameter would be cleaner, though the current approach works for a single-user CLI.
- **`as` casts in `loadItems`** — `item as Record<string, unknown>` then `item as unknown as Item` bypasses type safety at a data boundary. This is exactly where Zod (or a hand-rolled type guard) would earn its keep, but for a personal tool with a single writer, the risk is low.

### Bottom line

The worker is the heart of Hopper — the thing that makes agents actually *do work* — and it's the only part of the system with zero tests and zero separation between logic and I/O. Extracting the pure workflow decisions from the git/claude subprocess calls would bring the most important code under test with minimal disruption to the rest of the (quite clean) codebase.