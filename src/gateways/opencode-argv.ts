import type { SessionOptions } from "./agent-runner.ts";
import { type RunnerConfig, resolveOpencodeModel } from "./runner-config.ts";

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
 * - Model tier names (`deep|balanced|fast` — see `model-tier.ts`) are
 *   translated through {@link RunnerConfig.opencode.models} before being
 *   passed via `--model`. Native provider/model identifiers (containing `/`)
 *   are passed through unchanged.
 * - The agent name, when set, is passed via `--agent`. The matching agent
 *   definition is expected to be available either in the user's
 *   `opencode.json` or injected via the `OPENCODE_CONFIG_CONTENT` env var
 *   built by {@link import("./opencode-config-content.ts").buildOpencodeConfigContent}.
 */
export function buildOpencodeArgv(
  opencodeBin: string,
  prompt: string,
  options: SessionOptions = {},
  config: RunnerConfig = {},
  cwd?: string,
): string[] {
  const argv: string[] = [opencodeBin, "run", "--format", "json", "--dangerously-skip-permissions"];

  const resolvedModel = resolveOpencodeModel(options.model, config);
  if (resolvedModel) {
    argv.push("--model", resolvedModel);
  }

  if (options.agent) {
    argv.push("--agent", options.agent);
  }

  if (options.effort) {
    // opencode --variant is provider-specific (e.g. minimal|low|medium|high|max
    // on OpenAI gpt-5.x). Forward verbatim; the CLI errors if the level is
    // unsupported for the chosen model.
    argv.push("--variant", options.effort);
  }

  if (cwd) {
    argv.push("--dir", cwd);
  }

  argv.push("--", prompt);
  return argv;
}
