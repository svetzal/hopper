import { createInterface } from "node:readline/promises";

/** Ask a yes/no question; resolve true only on an affirmative answer. */
export type ConfirmFn = (question: string) => Promise<boolean>;

/**
 * Interactive confirmation gateway.
 *
 * Prompts on **stderr** (so a `--json`/piped stdout stays clean) and reads a
 * single line from stdin. When stdin is not a TTY — scripts, CI, agent workers —
 * it returns `false` **without prompting**: an unattended caller must pass
 * `--yes` to authorize a destructive action rather than hang or silently
 * proceed. Fail-closed by construction.
 */
export function createConfirmGateway(): ConfirmFn {
  return async (question: string): Promise<boolean> => {
    if (!process.stdin.isTTY) return false;
    const rl = createInterface({ input: process.stdin, output: process.stderr });
    try {
      const answer = (await rl.question(`${question} [y/N] `)).trim().toLowerCase();
      return answer === "y" || answer === "yes";
    } finally {
      rl.close();
    }
  };
}
