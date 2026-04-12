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
  if (options.tools && options.tools.length > 0) argv.push("--tools", ...options.tools);
  if (options.allowedTools && options.allowedTools.length > 0) {
    argv.push("--allowedTools", ...options.allowedTools);
  }
  if (options.disallowedTools && options.disallowedTools.length > 0) {
    argv.push("--disallowedTools", ...options.disallowedTools);
  }
  if (options.appendSystemPrompt) {
    argv.push("--append-system-prompt", options.appendSystemPrompt);
  }

  argv.push(prompt);
  return argv;
}
