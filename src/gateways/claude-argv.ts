/**
 * Options that control how a Claude session is invoked.
 *
 * All fields are optional. When none are set, the resulting argv matches the
 * legacy invocation exactly (stream-json output, `--dangerously-skip-permissions`,
 * no model / agent / tool restrictions) so existing callers are unaffected.
 */
export interface ClaudeSessionOptions {
  /** Model alias ("opus", "sonnet", "haiku") or full model ID. */
  model?: string;
  /** Agent name passed via `--agent`. */
  agent?: string;
  /**
   * Explicit allowlist of built-in tools via `--tools`. Pass `[""]` to disable
   * all tools. Caller-supplied values are forwarded verbatim.
   */
  tools?: string[];
  /** Additional tool permissions via `--allowedTools`. */
  allowedTools?: string[];
  /** Denied tools via `--disallowedTools`. */
  disallowedTools?: string[];
  /**
   * Permission mode. When set, `--dangerously-skip-permissions` is omitted so
   * the chosen mode takes effect.
   */
  permissionMode?: "plan" | "default" | "acceptEdits" | "bypassPermissions" | "auto" | "dontAsk";
  /** Text appended to Claude's default system prompt. */
  appendSystemPrompt?: string;
  /** Continue an existing audit file rather than starting fresh. */
  append?: boolean;
}

/**
 * Construct the argv for a `claude --print` invocation.
 *
 * Returns an array suitable for `Bun.spawn(argv, ...)`. Pure — no I/O.
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

  if (options.model) argv.push("--model", options.model);
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

  // Terminate option parsing with `--` so even if a future flag ends up
  // variadic, the prompt is always the final positional and never gets
  // siphoned into an option's value list.
  argv.push("--", prompt);
  return argv;
}
