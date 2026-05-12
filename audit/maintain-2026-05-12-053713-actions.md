All done. Here's the summary:

**Dependency update: `@types/node` 25.6.2 → 25.7.0** (patch update)

All other packages (`@biomejs/biome`, `@types/bun`, `typescript`) are already at their latest versions within the specified ranges.

**Quality gates — all green:**
- ✅ **lint** (`tsc --noEmit`): Zero errors
- ✅ **test**: 987 pass, 0 fail across 52 files
- ✅ **build**: Binary compiles and reports version `2.1.1`
- ✅ **pre-push hook**: Type-check + Biome + tests all passed on push to `origin/main`