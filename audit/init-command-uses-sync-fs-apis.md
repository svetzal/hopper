I now have a complete picture. Let me formulate the assessment:

```json
{ "severity": 3, "principle": "Bun-native", "category": "API Usage" }
```

## Assessment

The project is exceptionally well-structured overall — zero dependencies, strict TypeScript, consistent `--json` dual output, proper claim-token security, thorough store-level testing, and clean functional architecture. Most principles are followed to the letter.

### Most Violated Principle: **Bun-native**

> *"Use `Bun.file()` and `Bun.write()` for file I/O... Never use `fs.readFileSync` for JSON data when `Bun.file().json()` works."*

The project mixes Node.js `fs` APIs alongside Bun APIs in an inconsistent way:

**`src/store.ts` (line 1, 58):**
```typescript
import { mkdir } from "fs/promises";
// ...
await mkdir(storeDir, { recursive: true });  // line 58
```
This sits right next to `Bun.file()` on line 40 and `Bun.write()` on line 59. The same function (`saveItems`) uses Node's `mkdir` and then Bun's `Bun.write()` — a contradictory blend in a single 3-line operation.

**`src/commands/init.ts` (lines 1, 57-73):**
```typescript
import { mkdirSync, existsSync, readFileSync, writeFileSync } from "fs";
```
This is the most significant violation — **four** synchronous Node.js `fs` functions used throughout the command when Bun equivalents exist:
- `existsSync(fullPath)` → `await Bun.file(fullPath).exists()`
- `readFileSync(fullPath, "utf-8")` → `await Bun.file(fullPath).text()`
- `writeFileSync(fullPath, stamped, "utf-8")` → `await Bun.write(fullPath, stamped)`
- `mkdirSync(dir, { recursive: true })` → `await mkdir(dir, { recursive: true })` (at minimum make it async) or use `Bun.write()` which creates parent directories

This isn't just an API preference issue — `init.ts` uses **synchronous** I/O in an `async` function, which violates the spirit of Bun's async-first design. The function signature is already `async`, so there's no reason for the sync versions.

### How to Correct It

**1. `src/commands/init.ts`** — Convert to async Bun APIs:

```typescript
// Before
import { mkdirSync, existsSync, readFileSync, writeFileSync } from "fs";

// After — remove the fs import entirely
import { mkdir } from "fs/promises";  // only needed for directory creation

// Replace each usage:
// existsSync(fullPath)        → await Bun.file(fullPath).exists()
// readFileSync(fullPath, ...) → await Bun.file(fullPath).text()
// writeFileSync(fullPath, ..) → await Bun.write(fullPath, stamped)
// mkdirSync(dir, ...)         → await mkdir(dir, { recursive: true })
```

**2. `src/store.ts`** — Replace the `mkdir` import with Bun-compatible approach:

The `mkdir` on line 58 in `saveItems` ensures the store directory exists before writing. Since `Bun.write()` does **not** auto-create parent directories, you still need `mkdir` from `fs/promises` — but this is at least the async version and is one of the few Node stdlib functions without a direct Bun equivalent. This is acceptable, but you could document why it's the one exception.

The fix is contained, low-risk, and would bring the project into full alignment with its own stated Bun-native principle. The changes touch two files, are mechanically straightforward, and all existing tests cover the affected paths.