#!/usr/bin/env bun

import { addCommand } from "./commands/add.ts";
import { claimCommand } from "./commands/claim.ts";
import { completeCommand } from "./commands/complete.ts";
import { listCommand } from "./commands/list.ts";
import { requeueCommand } from "./commands/requeue.ts";
import { createTitleGenerator } from "./titler.ts";

const VERSION = "0.2.1";

export interface ParsedArgs {
  command: string;
  positional: string[];
  flags: Record<string, string | boolean>;
}

function parseArgs(args: string[]): ParsedArgs {
  const flags: Record<string, string | boolean> = {};
  const positional: string[] = [];

  let i = 0;
  while (i < args.length) {
    const arg = args[i]!;
    if (arg.startsWith("--")) {
      const key = arg.slice(2);
      const nextArg = args[i + 1];
      if (nextArg && !nextArg.startsWith("--")) {
        flags[key] = nextArg;
        i += 2;
      } else {
        flags[key] = true;
        i += 1;
      }
    } else {
      positional.push(arg);
      i += 1;
    }
  }

  return { command: positional[0] ?? "", positional: positional.slice(1), flags };
}

function printHelp(): void {
  console.log(`hopper v${VERSION} — personal work queue

Usage:
  hopper add <description>           Add a work item (LLM generates title)
  hopper list                        List queued + in-progress items
  hopper list --all                  Include completed items
  hopper list --completed            Show only completed items
  hopper claim [--agent <name>]      Claim next queued item (FIFO)
  hopper complete <token>            Complete a claimed item
  hopper complete <token> --result "…" Attach a result summary
  hopper requeue <id> --reason "…"   Return an in-progress item to queue
  hopper init                        Install Claude Code skill files

Options:
  --json      Output as JSON
  --agent     Agent name for claim/complete
  --help      Show this help
  --version   Show version`);
}

async function main(): Promise<void> {
  const args = Bun.argv.slice(2);
  const parsed = parseArgs(args);

  if (parsed.flags.version) {
    console.log(VERSION);
    return;
  }

  if (parsed.flags.help || !parsed.command) {
    printHelp();
    return;
  }

  switch (parsed.command) {
    case "add": {
      const titler = createTitleGenerator();
      await addCommand(parsed, titler);
      break;
    }
    case "list":
      await listCommand(parsed);
      break;
    case "claim":
      await claimCommand(parsed);
      break;
    case "complete":
      await completeCommand(parsed);
      break;
    case "requeue":
      await requeueCommand(parsed);
      break;
    case "init": {
      const { initCommand } = await import("./commands/init.ts");
      await initCommand(parsed.flags.json === true);
      break;
    }
    default:
      console.error(`Unknown command: ${parsed.command}`);
      printHelp();
      process.exit(1);
  }
}

main();
