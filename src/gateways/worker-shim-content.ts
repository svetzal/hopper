/**
 * Pure functions for building PATH-shim scripts that enforce Hopper worker
 * safety boundaries at the binary level.
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
  // Network egress — all verbs are out of scope. `aws` is NOT here: it gets a
  // dedicated read-only-allow shim (see AWS_READONLY / buildAwsReadonlyShimScript)
  // instead of a blanket deny.
  "curl",
  "wget",
  "gh",
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
 * Sentinel deny-map value for the `aws` shim: allow read-only actions
 * (`get-*`, `describe-*`, `list-*`, `query`, `scan`, `batch-get-item`), deny
 * everything else. Distinct from `"all"` (full deny) and a verb list (deny
 * specific first-token verbs) because the aws read/write distinction lives in
 * the action (2nd token, after any global flags), which neither of the other
 * two shapes can express.
 */
export const AWS_READONLY = "aws-readonly" as const;

/** The shape of a single binary's entry in a shim deny map. */
export type ShimSpec = ReadonlyArray<string> | "all" | typeof AWS_READONLY;

/** Maps binary name to its shim behaviour. */
export type ShimDenyMap = Map<string, ShimSpec>;

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
export function parseDisallowedTools(patterns: readonly string[]): ShimDenyMap {
  const result: ShimDenyMap = new Map();

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
 * `hopper-worker-shim: '<binary> <verb>' is denied in this managed session`
 */
export function buildShimScript(binary: string, deniedVerbs: ShimSpec): string {
  if (deniedVerbs === "all") {
    return (
      `#!/bin/sh\n` +
      `# hopper-worker-shim: ${binary} is fully denied in this managed session\n` +
      `echo "hopper-worker-shim: '${binary}' is denied in this managed session" >&2\n` +
      `exit 1\n`
    );
  }

  if (deniedVerbs === AWS_READONLY) {
    return buildAwsReadonlyShimScript();
  }

  const casePatterns = deniedVerbs
    .map(
      (verb) =>
        `    ${verb})\n` +
        `      echo "hopper-worker-shim: '${binary} ${verb}' is denied in this managed session" >&2\n` +
        `      exit 1\n` +
        `      ;;`,
    )
    .join("\n");

  return (
    `#!/bin/sh\n` +
    `# hopper-worker-shim: ${binary} — deny specific verbs in this managed session\n` +
    `case "$1" in\n` +
    `${casePatterns}\n` +
    `esac\n` +
    `exec env PATH="$HOPPER_REAL_PATH" ${binary} "$@"\n`
  );
}

/**
 * Build the content of the POSIX `/bin/sh` shim script for `aws`.
 *
 * `aws` command shape is `aws [global-flags] <service> <action> [args]`. The
 * read/write distinction lives in the ACTION token (e.g. `get-item` vs.
 * `put-item`), not the service, and global flags (`--region`, `--profile`,
 * ...) may precede the service — so this cannot use the generic `$1`-based
 * verb-deny `case` statement the way `git` does.
 *
 * The script scans the positional args, skipping recognised global flags
 * (and their values), to find the service (1st non-flag token) and action
 * (2nd non-flag token) WITHOUT consuming `$@` — the final `exec` always
 * re-execs with the original, untouched argument list.
 *
 * This is an ALLOW-LIST (default-deny): only actions matching `get-*`,
 * `describe-*`, `list-*`, or exactly `query`, `scan`, `batch-get-item` (plus
 * bare `aws`, `aws help`, and flag-only invocations like `aws --version`)
 * pass through. Any unrecognised or mutating action is denied, so a newly
 * added AWS API action is denied by default until explicitly allow-listed.
 */
export function buildAwsReadonlyShimScript(): string {
  return (
    `#!/bin/sh\n` +
    `# hopper-worker-shim: aws — allow read-only actions, deny mutations in investigation sessions\n` +
    `#\n` +
    `# Command shape is \`aws [global-flags] <service> <action> [args]\`. The read/write\n` +
    `# distinction lives in the ACTION token (get-item vs put-item), not the service,\n` +
    `# and global flags may precede the service. Scan past leading flags WITHOUT\n` +
    `# consuming positional args (so allowed calls exec with the original argv), then\n` +
    `# allow only clearly read-only actions (allow-list / default-deny).\n` +
    `service=""\n` +
    `action=""\n` +
    `skip_next=0\n` +
    `for tok in "$@"; do\n` +
    `  if [ "$skip_next" = "1" ]; then\n` +
    `    skip_next=0\n` +
    `    continue\n` +
    `  fi\n` +
    `  case "$tok" in\n` +
    `    --*=*) ;;\n` +
    `    --region|--profile|--output|--endpoint-url|--query|--ca-bundle|--color|--page-size|--max-items|--starting-token|--cli-binary-format|--cli-read-timeout|--cli-connect-timeout)\n` +
    `      skip_next=1 ;;\n` +
    `    -*) ;;\n` +
    `    *)\n` +
    `      if [ -z "$service" ]; then\n` +
    `        service="$tok"\n` +
    `      else\n` +
    `        action="$tok"\n` +
    `        break\n` +
    `      fi\n` +
    `      ;;\n` +
    `  esac\n` +
    `done\n` +
    `# Bare 'aws', 'aws help', or only global flags (e.g. 'aws --version') -> allow.\n` +
    `if [ -z "$service" ] || [ "$service" = "help" ]; then\n` +
    `  exec env PATH="$HOPPER_REAL_PATH" aws "$@"\n` +
    `fi\n` +
    `case "$action" in\n` +
    `  ""|help|get-*|describe-*|list-*|query|scan|batch-get-item)\n` +
    `    exec env PATH="$HOPPER_REAL_PATH" aws "$@" ;;\n` +
    `esac\n` +
    `echo "hopper-worker-shim: 'aws $action' is denied in investigation sessions" >&2\n` +
    `exit 1\n`
  );
}

/**
 * Build the shim deny map used for investigation sessions.
 *
 * Wraps {@link parseDisallowedTools} and overrides the `aws` entry with
 * {@link AWS_READONLY}. This is intentionally decoupled from the Claude
 * `disallowedTools` array: `aws` is deliberately absent from
 * `INVESTIGATION_DISALLOWED_TOOLS` (Claude's `disallowedTools` matching is
 * leading-token-prefix-based and cannot express "allow reads, deny writes"
 * for a 2nd-token distinction), but the PATH shim must still exist to enforce
 * that distinction at the binary level. This function is the single place
 * that re-injects the aws shim regardless of what the Claude-facing denylist
 * contains.
 */
export function buildInvestigationShimMap(patterns: readonly string[]): ShimDenyMap {
  const result = parseDisallowedTools(patterns);
  result.set("aws", AWS_READONLY);
  return result;
}
