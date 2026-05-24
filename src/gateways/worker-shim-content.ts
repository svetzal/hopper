/**
 * Pure functions for building the PATH-shim scripts that enforce the
 * investigation sandbox at the binary level.
 *
 * The `disallowedTools` denylist on Claude sessions is leading-token-prefix-
 * matched — `Bash(git commit:*)` is bypassed by `cd /tmp && git commit ...`
 * because the leading token is `cd`. PATH shims close that gap: hopper prepends
 * a shim directory to PATH so `git`, `curl`, etc. resolve to tiny shell scripts
 * that either delegate to the real binary (for allowed verbs) or exit 1 with a
 * clear error (for denied verbs), regardless of how the shell composed the call.
 *
 * Also covers the opencode runner, which silently ignores `disallowedTools`.
 */

/**
 * Binaries that should always be fully denied in investigation sessions.
 *
 * When any pattern for one of these binaries appears in the denylist, the
 * entire binary is collapsed to `"all"` rather than a per-verb list. This
 * covers package managers (where partially allowing sub-commands makes no
 * sense) and any other binary that the denylist author intends to block in
 * full rather than by verb.
 *
 * The set is derived from INVESTIGATION_DISALLOWED_TOOLS: every binary whose
 * listed verb(s) imply "deny the whole tool" (package managers, network-egress
 * tools, destructive filesystem tools) is included. Binaries like `git`,
 * `hopper`, `foundry`, and `evt` are NOT in this set because hopper allows
 * their read-only verbs.
 */
const FULL_DENY_BINARIES = new Set([
  // Package managers — no sub-command is safe to allow during investigation
  "npm",
  "bun",
  "pnpm",
  "yarn",
  "pip",
  "uv",
  "cargo",
  "brew",
  // Network egress — all verbs are out of scope
  "curl",
  "wget",
  "gh",
  "aws",
  "ssh",
  "scp",
  "rsync",
  // Destructive filesystem tools — always deny
  "rm",
  "mv",
  "chmod",
  "chown",
  "ln",
]);

/**
 * Parse the Claude `disallowedTools` pattern list into a per-binary deny map.
 *
 * Input patterns look like:
 * - `"Bash(git commit:*)"` → binary `git`, denied verb `commit`
 * - `"Bash(curl:*)"` → binary `curl`, full deny (`"all"`)
 * - `"Bash(npm install:*)"` → binary `npm`, full deny (package manager)
 * - `"Bash(uv pip:*)"` → binary `uv`, full deny (package manager)
 *
 * Only `Bash(...)` patterns are processed. Other tool names (e.g. `"Read"`) are
 * silently skipped.
 *
 * Full-deny decision rule:
 * 1. Single-word inner content (e.g. `curl`) → the word is the binary, full deny.
 * 2. Binary is in `FULL_DENY_BINARIES` → full deny regardless of verb.
 * 3. Otherwise → accumulate verb into a per-binary verb list.
 */
export function parseDisallowedTools(
  patterns: readonly string[],
): Map<string, ReadonlyArray<string> | "all"> {
  const result = new Map<string, ReadonlyArray<string> | "all">();

  for (const pattern of patterns) {
    const match = pattern.match(/^Bash\((.+):?\*?\)$/);
    if (!match?.[1]) continue;

    const inner = match[1].replace(/:?\*$/, "").trim();
    if (!inner) continue;

    const spaceIndex = inner.indexOf(" ");
    if (spaceIndex === -1) {
      // Single-word: the entire word is the binary — full deny
      result.set(inner, "all");
    } else {
      const binary = inner.slice(0, spaceIndex);
      const verb = inner.slice(spaceIndex + 1).trim();

      if (FULL_DENY_BINARIES.has(binary)) {
        // Package managers, network tools, destructive fs tools — full deny
        result.set(binary, "all");
      } else {
        const existing = result.get(binary);
        if (existing === "all") {
          // Already full-denied; keep that
        } else if (existing == null) {
          result.set(binary, [verb]);
        } else {
          result.set(binary, [...existing, verb]);
        }
      }
    }
  }

  return result;
}

/**
 * Build the content of a POSIX `/bin/sh` shim script for a given binary.
 *
 * When `deniedVerbs` is `"all"`, the script unconditionally writes a deny
 * message to stderr and exits 1.
 *
 * When `deniedVerbs` is a list, `$1` is inspected via a `case` statement. A
 * matching verb denies; anything else delegates to the real binary via `exec`,
 * restoring `HOPPER_REAL_PATH` so the real binary resolves correctly.
 *
 * The deny message format:
 * `hopper-worker-shim: '<binary> <verb>' is denied in investigation sessions`
 */
export function buildShimScript(
  binary: string,
  deniedVerbs: ReadonlyArray<string> | "all",
): string {
  if (deniedVerbs === "all") {
    return (
      `#!/bin/sh\n` +
      `# hopper-worker-shim: ${binary} is fully denied in investigation sessions\n` +
      `echo "hopper-worker-shim: '${binary}' is denied in investigation sessions" >&2\n` +
      `exit 1\n`
    );
  }

  const casePatterns = deniedVerbs
    .map(
      (verb) =>
        `    ${verb})\n` +
        `      echo "hopper-worker-shim: '${binary} ${verb}' is denied in investigation sessions" >&2\n` +
        `      exit 1\n` +
        `      ;;`,
    )
    .join("\n");

  return (
    `#!/bin/sh\n` +
    `# hopper-worker-shim: ${binary} — deny specific verbs in investigation sessions\n` +
    `case "$1" in\n` +
    `${casePatterns}\n` +
    `esac\n` +
    `exec env PATH="$HOPPER_REAL_PATH" ${binary} "$@"\n`
  );
}
