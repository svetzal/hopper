#!/usr/bin/env bun

import { addCommand } from "./commands/add.ts";
import { cancelCommand } from "./commands/cancel.ts";
import { claimCommand } from "./commands/claim.ts";
import { completeCommand } from "./commands/complete.ts";
import { listCommand } from "./commands/list.ts";
import { presetCommand } from "./commands/preset.ts";
import { requeueCommand } from "./commands/requeue.ts";
import { showCommand } from "./commands/show.ts";
import { workerCommand } from "./commands/worker.ts";
import { createTitleGenerator } from "./titler.ts";
import { VERSION } from "./constants.ts";

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
  hopper add <description> [--after <timespec>]              Add a work item (optionally scheduled)
  hopper add <description> [--dir <path> --branch <branch>]  Add with working directory
  hopper add --preset <name> [--after --every]               Create item from preset
  hopper show <id>                   Show full details of an item
  hopper list                        List queued + in-progress + scheduled items
  hopper list --all                  Include completed items
  hopper list --completed            Show only completed items
  hopper list --scheduled            Show only scheduled items
  hopper claim [--agent <name>]      Claim next queued item (FIFO)
  hopper complete <token>            Complete a claimed item
  hopper complete <token> --result "…" Attach a result summary
  hopper cancel <id>                 Cancel a queued item
  hopper requeue <id> --reason "…"   Return an in-progress item to queue
  hopper preset add <name> <desc> [--dir --branch]  Save a reusable template
  hopper preset list                                List saved presets
  hopper preset remove <name>                       Delete a preset
  hopper preset show <name>                         Show preset details
  hopper init                        Install Claude Code skill files
  hopper worker                      Run the Claude worker loop
  hopper worker --once               Process one item then exit
  hopper worker --agent <name>       Set agent name (default: claude-worker)
  hopper worker --interval <sec>     Poll interval in seconds (default: 60)
  hopper worker --concurrency <n>    Run up to N items in parallel (default: 1)

Options:
  --after     Schedule item for later (e.g. 1h, 30m, tomorrow 9am)
  --dir       Working directory for the task (add command)
  --branch    Git branch for the task (add command, required with --dir)
  --json      Output as JSON
  --agent     Agent name for claim/complete/worker
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
    case "cancel":
      await cancelCommand(parsed);
      break;
    case "complete":
      await completeCommand(parsed);
      break;
    case "requeue":
      await requeueCommand(parsed);
      break;
    case "show":
      await showCommand(parsed);
      break;
    case "preset":
      await presetCommand(parsed);
      break;
    case "init": {
      const { initCommand } = await import("./commands/init.ts");
      await initCommand(parsed.flags.json === true);
      break;
    }
    case "worker":
      await workerCommand(parsed);
      break;
    default:
      console.error(`Unknown command: ${parsed.command}`);
      printHelp();
      process.exit(1);
  }
}

main();
