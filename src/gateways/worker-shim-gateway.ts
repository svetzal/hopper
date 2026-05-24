/**
 * Gateway that materialises PATH-shim scripts on disk.
 *
 * Investigation sessions prepend `~/.hopper/worker-shims/` to PATH and set
 * `HOPPER_REAL_PATH` to the original PATH. Each shim script intercepts a
 * specific binary and denies the verbs listed in INVESTIGATION_DISALLOWED_TOOLS
 * regardless of how the shell composed the call — closing the shell-composition
 * bypass where `cd /tmp && git commit ...` slips past `Bash(git commit:*)`.
 *
 * The shim layer also covers the opencode runner, which silently ignores the
 * `disallowedTools` option.
 *
 * Shims are POSIX `/bin/sh` scripts and are not installed on Windows. Windows
 * investigation sessions fall back to the denylist guardrail alone.
 *
 * TODO: Engineering-phase items would also benefit from this shim layer if the
 * design is later extended to cover EXECUTE_DISALLOWED_TOOLS. The current
 * implementation is scoped to investigation sessions only.
 */

import { chmod, mkdir, readdir, readFile, stat, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { buildShimScript } from "./worker-shim-content.ts";

export interface WorkerShimGateway {
  /**
   * Ensure `shimDir` contains exactly the shim files described by `denyMap`.
   *
   * - Files present in `denyMap` but absent or drifted on disk are written and
   *   made executable (chmod 0o755).
   * - Files present on disk but absent from `denyMap` are deleted.
   * - Idempotent: files whose content matches the desired body are not rewritten
   *   (preserves mtime for external change detection).
   *
   * On Windows this is a no-op (shims are POSIX-only).
   */
  synchronize(shimDir: string, denyMap: Map<string, ReadonlyArray<string> | "all">): Promise<void>;
}

export function createWorkerShimGateway(): WorkerShimGateway {
  return {
    async synchronize(
      shimDir: string,
      denyMap: Map<string, ReadonlyArray<string> | "all">,
    ): Promise<void> {
      if (process.platform === "win32") {
        console.warn(
          "hopper: PATH shims are POSIX-only; investigation sandbox on Windows relies on the denylist alone.",
        );
        return;
      }

      await mkdir(shimDir, { recursive: true });

      // Build desired shim bodies
      const desired = new Map<string, string>();
      for (const [binary, deniedVerbs] of denyMap) {
        desired.set(binary, buildShimScript(binary, deniedVerbs));
      }

      // List current files in shimDir
      let existing: string[] = [];
      try {
        existing = await readdir(shimDir);
      } catch {
        // Directory may not exist yet (mkdir above handles creation, but a race
        // is possible in theory). Treat as empty.
      }

      // Write / update shims
      for (const [binary, body] of desired) {
        const filePath = join(shimDir, binary);
        let currentBody: string | null = null;
        try {
          currentBody = await readFile(filePath, "utf8");
        } catch {
          // File does not exist yet
        }

        if (currentBody !== body) {
          await writeFile(filePath, body, { encoding: "utf8" });
          await chmod(filePath, 0o755);
        } else {
          // Ensure executable bit even when content is unchanged
          const s = await stat(filePath);
          if ((s.mode & 0o111) === 0) {
            await chmod(filePath, 0o755);
          }
        }
      }

      // Remove stale shims
      for (const filename of existing) {
        if (!desired.has(filename)) {
          await unlink(join(shimDir, filename)).catch(() => undefined);
        }
      }
    },
  };
}
