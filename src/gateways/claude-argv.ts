import { resolveProfileBinding } from "../profile.ts";
import type { SessionOptions } from "./agent-runner.ts";

/**
 * Legacy alias for the runner-agnostic {@link SessionOptions}. Kept so
 * existing imports keep compiling; new code should import `SessionOptions`
 * directly from `./agent-runner.ts`.
 */
export type ClaudeSessionOptions = SessionOptions;

/**
 * Construct the argv for a `claude --print` invocation.
 *
 * Returns an array suitable for `Bun.spawn(argv, ...)`. Pure — no I/O.
 *
 * Model resolution: {@link options.model} is looked up against the profile's
 * `models` map (the anthropic-shipped profile maps `deep→opus`, etc.).
 * Strings already containing `/` pass through verbatim. Without a profile,
 * the model string forwards as-is — the claude CLI will surface invalid
 * model names with its own error.
 */
export function buildClaudeArgv(
  claudeBin: string,
  prompt: string,
  options: ClaudeSessionOptions = {},
): string[] {
  const argv: string[] = [claudeBin, "--print", "--verbose"];

  if (!options.permissionMode) {
    argv.push("--dangerously-skip-permissions");
  } else {
    argv.push("--permission-mode", options.permissionMode);
  }

  argv.push("--output-format", "stream-json");

  const binding = options.profile
    ? resolveProfileBinding(options.model, options.profile)
    : options.model
      ? { model: options.model }
      : undefined;
  if (binding?.model) {
    argv.push("--model", binding.model);
  }
  if (options.agent) argv.push("--agent", options.agent);
  // --tools, --allowedTools, --disallowedTools are all Commander-variadic on
  // the claude side. Passing each entry as its own argv token causes Commander
  // to greedily consume every subsequent positional — including the prompt —
  // and claude dies with "Input must be provided either through stdin or as a
  // prompt argument when using --print". Join into a single comma-separated
  // token instead, which matches the form the --help docs demonstrate
  // ("Bash,Edit,Read") and leaves the prompt as an unambiguous positional.
  if (options.tools && options.tools.length > 0) {
    argv.push("--tools", options.tools.join(","));
  }
  if (options.allowedTools && options.allowedTools.length > 0) {
    argv.push("--allowedTools", options.allowedTools.join(","));
  }
  if (options.disallowedTools && options.disallowedTools.length > 0) {
    argv.push("--disallowedTools", options.disallowedTools.join(","));
  }
  if (options.appendSystemPrompt) {
    argv.push("--append-system-prompt", options.appendSystemPrompt);
  }
  // Effort precedence: profile-tier effort (if set) overrides per-phase default.
  // claude --effort accepts low|medium|high|xhigh|max. Map hopper's unified
  // "minimal" to claude's nearest equivalent ("low"); everything else is
  // forwarded verbatim so callers can still pass runner-native values.
  const effort = binding?.effort ?? options.effort;
  if (effort) {
    const value = effort === "minimal" ? "low" : effort;
    argv.push("--effort", value);
  }

  // Terminate option parsing with `--` so even if a future flag ends up
  // variadic, the prompt is always the final positional and never gets
  // siphoned into an option's value list.
  argv.push("--", prompt);
  return argv;
}
