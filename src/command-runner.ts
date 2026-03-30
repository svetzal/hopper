import type { ParsedArgs } from "./cli.ts";
import type { CommandResult } from "./command-result.ts";
import { toErrorMessage } from "./error-utils.ts";

export async function runCommand(
  fn: (parsed: ParsedArgs) => Promise<CommandResult>,
  parsed: ParsedArgs,
): Promise<void> {
  try {
    const result = await fn(parsed);
    if (result.status === "error") {
      console.error(result.message);
      process.exit(result.exitCode ?? 1);
    }
    if (parsed.flags.json === true) {
      console.log(JSON.stringify(result.data, null, 2));
    } else {
      if (result.warnings) {
        for (const warning of result.warnings) {
          console.warn(warning);
        }
      }
      console.log(result.humanOutput);
    }
  } catch (err) {
    console.error(toErrorMessage(err));
    process.exit(1);
  }
}
