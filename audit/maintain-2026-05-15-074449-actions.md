All done. Here's a summary of what was done:

**Dependency update applied:**
- `@types/node`: `^25.7.0` → `^25.8.0` (minor update)

All other packages (`@biomejs/biome`, `@types/bun`, `typescript`) were already at their latest compatible versions per the range specifiers.

**Quality gates — all passed:**
- ✅ **lint**: `tsc --noEmit` + Biome check — zero errors/warnings
- ✅ **test**: 1013 tests pass, 0 failures across 52 files
- ✅ **build**: Compiled to `build/hopper` successfully
- ✅ **pre-push hook**: All checks passed, pushed to `origin/main`

**Note:** There are pre-existing uncommitted changes to `src/store.ts` in the working directory (a refactoring that introduces `transact`/`transactIfChanged` helpers). These were not part of this dependency update and are left unstaged for a separate commit when that work is ready.