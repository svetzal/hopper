Now I have a thorough understanding of the codebase. Here is the complete plan:

---

## Plan: Extract Functional Core from `worker.ts`

### Goal
Separate the pure business logic in `worker.ts` from its I/O operations, making the workflow's most critical decision logic testable. Follow the Functional Core, Imperative Shell pattern.

---

### Step 1: Extract `extractResult` into its own module and test it

**Why:** `extractResult` is already a pure function buried in an untestable file. It parses JSONL output — non-trivial logic that deserves its own tests.

**Actions:**
1. Create `src/extract-result.ts` exporting `extractResult(jsonlOutput: string): string` — move the function body verbatim from `worker.ts` lines 125–135.
2. Create `src/extract-result.test.ts` with tests covering:
   - A valid JSONL stream containing a `{ type: "result", result: "..." }` line → returns the result string.
   - Multiple JSON lines where only one is a result → returns the correct one.
   - No result line present → returns `"(see audit log for details)"`.
   - Lines that are not valid JSON (mixed with valid ones) → skips them gracefully.
   - Empty string input → returns the fallback.
3. Update `worker.ts` to `import { extractResult } from "../extract-result.ts"` and remove the inline definition.
4. Run `bun test src/extract-result.test` — all green.

---

### Step 2: Define gateway interfaces for Git and Claude

**Why:** The worker's I/O operations (git subprocess calls, Claude process spawning, audit file writing) need to be behind interfaces so the workflow logic can be tested with mocks. Gateways should be thin wrappers with no business logic.

**Actions:**
1. Create `src/gateways/git-gateway.ts` with:
   ```typescript
   export interface GitGateway {
     worktreeAdd(repoDir: string, worktreePath: string, targetBranch: string, itemId: string): Promise<string>;
     worktreeRemove(repoDir: string, worktreePath: string): Promise<void>;
     isWorktreeDirty(worktreePath: string): Promise<boolean>;
     mergeWorkBranch(repoDir: string, targetBranch: string, workBranch: string): Promise<MergeOutcome>;
   }
   ```
   Also move the `MergeOutcome` type here (currently defined on line 75–77 of `worker.ts`).
   Export a `createGitGateway(): GitGateway` factory that contains the existing `Bun.spawn`-based implementations (moved verbatim from `worker.ts` functions `gitWorktreeAdd`, `gitWorktreeRemove`, `isWorktreeDirty`, `gitMergeWorkBranch`).

2. Create `src/gateways/claude-gateway.ts` with:
   ```typescript
   export interface ClaudeGateway {
     runSession(prompt: string, cwd: string, auditFile: string, options?: { append?: boolean }): Promise<{ exitCode: number; result: string }>;
   }
   ```
   Export a `createClaudeGateway(): ClaudeGateway` factory that contains the existing `spawnClaude` implementation (moved verbatim from `worker.ts` lines 137–163). It will import `extractResult` from `../extract-result.ts`.

3. Create `src/gateways/fs-gateway.ts` with:
   ```typescript
   export interface FsGateway {
     ensureDir(path: string): Promise<void>;
     writeFile(path: string, content: string): Promise<void>;
   }
   ```
   Export a `createFsGateway(): FsGateway` using `mkdir` and `Bun.write`.

4. No tests for gateway implementations — they are thin wrappers per the project's testing philosophy.

---

### Step 3: Extract the pure workflow decision logic into `src/worker-workflow.ts`

**Why:** The `workerCommand` function (lines 165–277) contains a state machine: claim → worktree setup → claude run → auto-commit → merge → complete/requeue. The *decisions* at each step are pure logic that should be testable without spawning processes.

**Actions:**
1. Create `src/worker-workflow.ts` with a pure function that orchestrates the workflow decisions. Design it as a series of small, pure decision functions:

   ```typescript
   export interface WorkerConfig {
     agentName: string;
     homedir: string;
   }

   /** Determine what working directory setup is needed */
   export function resolveWorkSetup(item: Item): 
     | { type: "worktree"; repoDir: string; branch: string; worktreePath: string }
     | { type: "existing-dir"; dir: string }
     | { type: "cwd" }

   /** Build the prompt for the Claude session */
   export function buildTaskPrompt(item: Item): string

   /** Build the auto-commit prompt */
   export function buildAutoCommitPrompt(item: Item): string

   /** Decide what to do after Claude exits */
   export function resolvePostClaudeAction(
     claudeExitCode: number,
     hasWorktree: boolean,
     isWorktreeDirty: boolean,
   ): { shouldAutoCommit: boolean }

   /** Decide whether and how to merge */
   export function resolveMergeAction(
     claudeExitCode: number,
     workBranch: string | undefined,
     item: Item,
   ): { shouldMerge: boolean } | { shouldMerge: false }

   /** Decide whether to complete or leave for manual requeue */
   export function resolveCompletionAction(
     claudeExitCode: number,
     claudeResult: string,
     mergeNote: string,
   ): { action: "complete"; result: string } | { action: "failed"; result: string }

   /** Compute audit file paths from item ID and home directory */
   export function resolveAuditPaths(itemId: string, homedir: string): {
     auditDir: string;
     auditFile: string;
     resultFile: string;
   }
   ```

2. Move the corresponding logic from `workerCommand` into these pure functions. For example:
   - `resolveWorkSetup` encodes lines 198–212 (the `if (item.workingDir && item.branch)` / `else if` / `else` logic).
   - `buildTaskPrompt` encodes line 214.
   - `resolvePostClaudeAction` encodes lines 220–230 (the auto-commit decision).
   - `resolveCompletionAction` encodes lines 259–267 (complete vs. failed decision).
   - `resolveAuditPaths` encodes lines 193–196.

---

### Step 4: Test the pure workflow functions

**Why:** These are the critical decisions that determine whether work gets completed, merged, or preserved. They deserve thorough test coverage.

**Actions:**
1. Create `src/worker-workflow.test.ts` with tests for each pure function:

   **`resolveWorkSetup` tests:**
   - Item with `workingDir` and `branch` → returns `type: "worktree"` with computed worktree path.
   - Item with `workingDir` but no `branch` → returns `type: "existing-dir"`.
   - Item with neither → returns `type: "cwd"`.

   **`buildTaskPrompt` tests:**
   - Returns prompt containing item title and description.

   **`buildAutoCommitPrompt` tests:**
   - Returns prompt containing item title.

   **`resolvePostClaudeAction` tests:**
   - Worktree exists and is dirty → `shouldAutoCommit: true`.
   - Worktree exists but clean → `shouldAutoCommit: false`.
   - No worktree → `shouldAutoCommit: false` regardless of dirty flag.

   **`resolveMergeAction` tests:**
   - Claude exit 0, work branch exists, item has branch → `shouldMerge: true`.
   - Claude exit non-zero → `shouldMerge: false`.
   - No work branch → `shouldMerge: false`.

   **`resolveCompletionAction` tests:**
   - Claude exit 0 → `action: "complete"` with combined result + merge note.
   - Claude exit non-zero → `action: "failed"`.

   **`resolveAuditPaths` tests:**
   - Returns correct directory and file paths based on item ID.

2. Run `bun test src/worker-workflow.test` — all green.

---

### Step 5: Rewrite `workerCommand` as the imperative shell

**Why:** With the pure logic extracted and gateway interfaces defined, the `workerCommand` becomes a thin orchestrator that wires gateways to decisions — easy to read, and the only untested code is trivial glue.

**Actions:**
1. Rewrite `src/commands/worker.ts` to:
   - Accept gateway dependencies (or use default real implementations).
   - Use the pure functions from `worker-workflow.ts` for all decisions.
   - Call gateways for all I/O.
   - The function signature becomes:
     ```typescript
     export async function workerCommand(
       parsed: ParsedArgs,
       deps?: {
         git?: GitGateway;
         claude?: ClaudeGateway;
         fs?: FsGateway;
       }
     ): Promise<void>
     ```
   - Default `deps` to the real gateway factories when not provided (so `cli.ts` doesn't change).
   - The body follows the same flow but delegates decisions to pure functions and I/O to gateways.

2. Verify `cli.ts` still calls `workerCommand(parsed)` with no changes needed (defaults kick in).

---

### Step 6: Run full test suite, lint, and verify

**Actions:**
1. Run `bun test` — all existing tests plus new tests pass.
2. Run `bun test -- --coverage` — verify the new modules have adequate coverage.
3. Run `bun run lint` — zero type errors.
4. Run `bun run build` — binary still compiles.
5. Manually verify `bun run dev -- worker --once` still works end-to-end (smoke test).

---

### Step 7: Update documentation

**Actions:**
1. Update the source layout table in `AGENTS.md` to reflect the new files:

   | File | Purpose |
   |------|---------|
   | `src/extract-result.ts` | Pure JSONL result parser |
   | `src/worker-workflow.ts` | Pure workflow decision logic for the worker |
   | `src/gateways/git-gateway.ts` | Thin wrapper around git subprocess calls |
   | `src/gateways/claude-gateway.ts` | Thin wrapper around Claude CLI process |
   | `src/gateways/fs-gateway.ts` | Thin wrapper around filesystem operations |

2. Add a note under "Key patterns" explaining the gateway pattern used in the worker.

---

### Summary of new files

| File | Type | Tested? |
|------|------|---------|
| `src/extract-result.ts` | Pure function | ✅ `src/extract-result.test.ts` |
| `src/worker-workflow.ts` | Pure functions | ✅ `src/worker-workflow.test.ts` |
| `src/gateways/git-gateway.ts` | Gateway (thin I/O wrapper) | ❌ (by design) |
| `src/gateways/claude-gateway.ts` | Gateway (thin I/O wrapper) | ❌ (by design) |
| `src/gateways/fs-gateway.ts` | Gateway (thin I/O wrapper) | ❌ (by design) |
| `src/commands/worker.ts` | Imperative shell (rewritten) | ❌ (thin glue) |

### What this does NOT change
- No changes to `store.ts`, `format.ts`, `cli.ts`, `titler.ts`, or any other command files.
- No new runtime dependencies.
- No changes to the CLI interface or `--json` output.
- The secondary observations (titler testing, module-level mutable state in store, `as` casts in `loadItems`) are deliberately deferred — they are lower severity and independent concerns that can be addressed separately without blocking this refactor.