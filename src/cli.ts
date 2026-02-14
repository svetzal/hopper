#!/usr/bin/env bun

import { addCommand } from "./commands/add.ts";
import { listCommand } from "./commands/list.ts";
import { createTitleGenerator } from "./titler.ts";

const VERSION = "0.1.0";

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
  hopper add <description>      Add a work item (LLM generates title)
  hopper list                   List queued items (newest first)

Options:
  --json      Output as JSON
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
    default:
      console.error(`Unknown command: ${parsed.command}`);
      printHelp();
      process.exit(1);
  }
}

main();
