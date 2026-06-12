import { resolveSessionBinding } from "../profile.ts";
import type { SessionOptions } from "./agent-runner.ts";

/**
 * Construct the argv for an `opencode run --format json` invocation.
 *
 * Returns the argv array suitable for `Bun.spawn(argv, ...)`. Pure — no I/O.
 *
 * The opencode CLI surface differs meaningfully from claude's:
 *
 * - There are no CLI flags for tool allowlists, denylists, or permission
 *   modes. Those fields in {@link SessionOptions} are silently ignored.
 * - Hopper-dispatched runs always pass `--dangerously-skip-permissions`
 *   because the worker is unattended.
 * - Hopper-dispatched runs always pass `--format json` so the audit stream
 *   stays machine-parseable.
 * - The prompt is a positional `message` argument. Like claude, we terminate
 *   option parsing with `--` so a future flag can't siphon it.
 * - Model names (tier aliases like `fast`, user-defined aliases like
 *   `qwen-bf16`, or native IDs like `openai/gpt-5.5`) are resolved through
 *   the supplied profile's `models` map before being passed via `--model`.
 *   Strings containing `/` (e.g. `openai/gpt-5.3-codex`) pass through
 *   unchanged so callers can mix freely.
 * - The agent name, when set, is passed via `--agent`. The matching agent
 *   definition is expected to be available either in the user's
 *   `opencode.json` or injected via the `OPENCODE_CONFIG_CONTENT` env var
 *   built by {@link import("./opencode-config-content.ts").buildOpencodeConfigContent}.
 */
export function buildOpencodeArgv(
  opencodeBin: string,
  prompt: string,
  options: SessionOptions = {},
  cwd?: string,
): string[] {
  const argv: string[] = [opencodeBin, "run", "--format", "json", "--dangerously-skip-permissions"];

  const binding = resolveSessionBinding(options.model, options.profile);
  if (binding?.model) {
    argv.push("--model", binding.model);
  }

  if (options.agent) {
    argv.push("--agent", options.agent);
  }

  // Effort precedence: profile-tier effort (if set) overrides per-phase default.
  // opencode --variant is provider-specific (e.g. minimal|low|medium|high|max
  // on OpenAI gpt-5.x). Forward verbatim; the CLI errors if the level is
  // unsupported for the chosen model.
  const effort = binding?.effort ?? options.effort;
  if (effort) {
    argv.push("--variant", effort);
  }

  if (cwd) {
    argv.push("--dir", cwd);
  }

  argv.push("--", prompt);
  return argv;
}
