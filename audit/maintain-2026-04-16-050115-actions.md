All dependencies in the hopper project are already at their latest compatible versions — no updates were needed.

Here's the current state:

| Package | Version | Role |
|---|---|---|
| `@biomejs/biome` | `^2.4.12` | Linter/formatter |
| `@types/bun` | `^1.3.12` | Bun type definitions |
| `typescript` | `^6.0.2` | TypeScript compiler |
| `@types/node` | `^25.6.0` | Node type definitions |

All three quality gates passed cleanly:
- **Lint** (`tsc --noEmit`): zero errors
- **Tests**: 817 passing, 0 failing across 43 files
- **Build**: compiled `build/hopper` successfully in ~75ms