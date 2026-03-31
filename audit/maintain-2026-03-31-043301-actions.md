All dependencies are up to date. Here's what was found and changed:

| Package | Was | Now | Action |
|---|---|---|---|
| `@biomejs/biome` | 2.4.9 | **2.4.10** | ✅ Updated (patch) |
| `@types/bun` | 1.3.11 | 1.3.11 | No change |
| `@types/node` | 25.5.0 | 25.5.0 | No change |
| `typescript` | 6.0.2 | 6.0.2 | No change |

Only `@biomejs/biome` had a new release — a safe patch bump. All quality gates passed after the update:

- ✅ **Type check** (`tsc --noEmit`): zero errors
- ✅ **Tests** (`bun test`): 554 tests pass across 36 files
- ✅ **Biome lint** (`biome check src/`): 76 files, no issues
- ✅ **Build** (`bun build --compile`): `build/hopper` compiles and runs correctly (v1.4.1)

The `package.json` and `bun.lock` files have been updated in place. Let me know if you'd like to commit these changes.