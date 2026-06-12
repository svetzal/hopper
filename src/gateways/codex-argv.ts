import { resolveSessionBinding } from "../profile.ts";
import type { SessionOptions } from "./agent-runner.ts";

/**
 * Construct the argv for a `codex exec --json` invocation.
 *
 * Codex has no Claude-style `--agent`, tool allowlist, or tool denylist flags.
 * Those concerns are handled outside argv construction by prompt injection and
 * Hopper's PATH-shim sandbox. The argv maps only the native execution surface:
 * model, cwd, unattended approvals/sandboxing, JSONL event output, and final
 * message capture.
 */
export function buildCodexArgv(
  codexBin: string,
  prompt: string,
  options: SessionOptions = {},
  outputLastMessagePath?: string,
): string[] {
  const argv: string[] = [
    codexBin,
    "exec",
    "--json",
    "--color",
    "never",
    "--dangerously-bypass-approvals-and-sandbox",
  ];

  const binding = resolveSessionBinding(options.model, options.profile);
  if (binding?.model) {
    argv.push("--model", binding.model);
  }

  if (outputLastMessagePath) {
    argv.push("--output-last-message", outputLastMessagePath);
  }

  argv.push("--", prompt);
  return argv;
}
