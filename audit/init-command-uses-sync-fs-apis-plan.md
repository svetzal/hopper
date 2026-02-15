Here's a summary of what was done:

## Changes Made

### `src/commands/init.ts` — Converted to Bun-native async APIs

**Before:** Imported 4 synchronous Node.js `fs` functions (`mkdirSync`, `existsSync`, `readFileSync`, `writeFileSync`) and used them inside an `async` function — contradicting both Bun-native and async-first principles.

**After:** 
- `import { mkdirSync, existsSync, readFileSync, writeFileSync } from "fs"` → `import { mkdir } from "fs/promises"`
- `existsSync(fullPath)` → `await Bun.file(fullPath).exists()` (with a local `fileRef` variable for reuse)
- `readFileSync(fullPath, "utf-8")` → `await fileRef.text()`
- `writeFileSync(fullPath, stamped, "utf-8")` → `await Bun.write(fullPath, stamped)`
- `mkdirSync(dir, { recursive: true })` → `await mkdir(dir, { recursive: true })`

The `fs` import is now completely removed. Only `fs/promises.mkdir` remains (since `Bun.write()` doesn't create parent directories).

### `src/store.ts` — Added explanatory comment

Added a comment on the `mkdir` import explaining why it's the one Node.js stdlib exception: `Bun.write()` does not create parent directories, so `mkdir` from `fs/promises` is necessary.