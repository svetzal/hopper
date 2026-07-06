#!/usr/bin/env bun

import { Command } from "commander";
import { runCommand } from "./command-runner.ts";
import { collect, toParsedArgs } from "./commander-adapter.ts";
import { addCommand } from "./commands/add.ts";
import { createAgentResolver } from "./commands/add-agent-resolver.ts";
import { auditCommand } from "./commands/audit.ts";
import { cancelCommand } from "./commands/cancel.ts";
import { claimCommand } from "./commands/claim.ts";
import { completeCommand } from "./commands/complete.ts";
import { editCommand } from "./commands/edit.ts";
import { integrateCommand } from "./commands/integrate.ts";
import { listCommand } from "./commands/list.ts";
import { presetCommand } from "./commands/preset.ts";
import { profilesCommand } from "./commands/profiles.ts";
import { requeueCommand } from "./commands/requeue.ts";
import { showCommand } from "./commands/show.ts";
import { tagCommand, untagCommand } from "./commands/tag.ts";
import { workerCommand } from "./commands/worker-loop.ts";
import { VERSION } from "./constants.ts";
import { createAgentsGateway } from "./gateways/agents-gateway.ts";
import { createAuditGateway } from "./gateways/audit-gateway.ts";
import { createGitGateway } from "./gateways/git-gateway.ts";
import { createLlmGateway } from "./gateways/llm-gateway.ts";
import { createProfilesGateway } from "./gateways/profiles-gateway.ts";
import { createRoutingRunner } from "./gateways/routing-runner.ts";
import { createTitleGenerator } from "./titler.ts";

/**
 * The normalized argument shape every command body consumes. Commander parses
 * and validates at the front door; {@link toParsedArgs} adapts its output into
 * this shape (see `commander-adapter.ts`), so command implementations stay
 * parser-agnostic and unit-testable in isolation.
 */
export interface ParsedArgs {
  command: string;
  positional: string[];
  flags: Record<string, string | boolean>;
  arrayFlags: Record<string, string[]>;
}

/**
 * Command orchestrators + gateway factories, injectable for testing. Mirrors
 * mailctl's `defaultDeps` pattern: tests build the program with spy commands to
 * assert parse behaviour (aliases, repeatables, unknown-flag rejection) without
 * running any I/O.
 */
export interface CliDeps {
  addCommand: typeof addCommand;
  listCommand: typeof listCommand;
  claimCommand: typeof claimCommand;
  cancelCommand: typeof cancelCommand;
  completeCommand: typeof completeCommand;
  requeueCommand: typeof requeueCommand;
  editCommand: typeof editCommand;
  integrateCommand: typeof integrateCommand;
  auditCommand: typeof auditCommand;
  showCommand: typeof showCommand;
  tagCommand: typeof tagCommand;
  untagCommand: typeof untagCommand;
  presetCommand: typeof presetCommand;
  profilesCommand: typeof profilesCommand;
  workerCommand: typeof workerCommand;
}

export const defaultDeps: CliDeps = {
  addCommand,
  listCommand,
  claimCommand,
  cancelCommand,
  completeCommand,
  requeueCommand,
  editCommand,
  integrateCommand,
  auditCommand,
  showCommand,
  tagCommand,
  untagCommand,
  presetCommand,
  profilesCommand,
  workerCommand,
};

/** Attach the shared `--json` flag (every command that reports data accepts it). */
function withJson(cmd: Command): Command {
  return cmd.option("--json", "Output as JSON");
}

/**
 * Build the full commander program. Pure construction — no parsing or I/O
 * happens until `.parseAsync()` is called. `[mutates]` markers in descriptions
 * make the read/write boundary visible in `--help` before anything runs.
 */
export function buildProgram(deps: CliDeps = defaultDeps): Command {
  const program = new Command();

  program
    .name("hopper")
    .description("personal work queue — distribute tasks to AI agents and shell commands")
    .version(VERSION, "--version", "Show version")
    .showSuggestionAfterError(true)
    .configureHelp({ showGlobalOptions: false });

  // ── add ──────────────────────────────────────────────────────────────────
  withJson(
    program
      .command("add [description]")
      .summary("[mutates] Add a work item to the queue")
      .description(
        "Add a work item to the queue. Description may be passed as an argument, " +
          "piped on stdin, or taken from a preset.",
      )
      .option("-p, --priority <level>", "Priority: high, normal, or low")
      .option("--after <timespec>", "Schedule for later (e.g. 1h, 30m, 'tomorrow 9am')")
      .option("--every <interval>", "Make recurring (e.g. 4h, 1d). Minimum 5 minutes")
      .option("--times <n>", "Limit recurrences to n runs (requires --every)")
      .option("--until <date>", "End date for recurrence (requires --every)")
      .option("--command <cmd>", "Shell command to run instead of an agent")
      .option("--dir <path>", "Working directory for the task")
      .option("--branch <branch>", "Git branch (required with --dir unless --command is set)")
      .option("--type <type>", "Task type: investigation, engineering, task (default: task)")
      .option("--agent <name>", "Pin a craftsperson/agent")
      .option("--profile <name>", "Profile name (defaults to defaultProfile from config.json)")
      .option("--preset <name>", "Create item from a saved preset")
      .option("--retries <n>", "Retry budget for engineering items")
      .option("--tag <tag>", "Tag (repeatable)", collect, [])
      .option("--after-item <id>", "Block on another item (repeatable)", collect, [])
      .option("--depends-on <id>", "Alias for --after-item (repeatable)", collect, []),
  )
    .addHelpText(
      "after",
      "\nExamples:\n" +
        "  hopper add 'Refactor auth to JWT' --dir ~/proj --branch main\n" +
        "  hopper add 'Nightly digest' --every 1d --after '9am'\n" +
        "  echo 'fix the flaky test' | hopper add -p high",
    )
    .action(async (description: string | undefined, opts: Record<string, unknown>) => {
      const apiKey = process.env.OPENAI_API_KEY ?? "";
      const llm = apiKey ? createLlmGateway(apiKey) : undefined;
      const titler = createTitleGenerator(llm);
      const profilesGateway = createProfilesGateway();
      const agentResolver = createAgentResolver(createAgentsGateway(), createRoutingRunner());

      // Merge the --depends-on alias into --after-item before adapting.
      const afterItem = [
        ...((opts.afterItem as string[] | undefined) ?? []),
        ...((opts.dependsOn as string[] | undefined) ?? []),
      ];
      const merged = { ...opts, afterItem };
      delete (merged as Record<string, unknown>).dependsOn;

      const parsed = toParsedArgs(description ? [description] : [], merged, "add");
      await runCommand(
        (p) => deps.addCommand(p, titler, profilesGateway, undefined, agentResolver),
        parsed,
      );
    });

  // ── list ─────────────────────────────────────────────────────────────────
  withJson(
    program
      .command("list")
      .summary("List queued, in-progress, and scheduled items")
      .option("--all", "Include completed items")
      .option("--completed", "Show only completed items")
      .option("--scheduled", "Show only scheduled items")
      .option("--tag <tag>", "Filter by tag (repeatable, OR logic)", collect, [])
      .option("--priority <level>", "Filter by priority")
      .option("--type <type>", "Filter by task type (investigation|engineering|task)"),
  ).action(async (opts: Record<string, unknown>) => {
    await runCommand(deps.listCommand, toParsedArgs([], opts, "list"));
  });

  // ── claim ────────────────────────────────────────────────────────────────
  withJson(
    program
      .command("claim")
      .summary("[mutates] Claim the next queued item (priority, then FIFO)")
      .option("--agent <name>", "Agent name recorded on the claim"),
  ).action(async (opts: Record<string, unknown>) => {
    await runCommand(deps.claimCommand, toParsedArgs([], opts, "claim"));
  });

  // ── cancel ───────────────────────────────────────────────────────────────
  withJson(
    program
      .command("cancel <id>")
      .summary("[mutates] Cancel a queued or in-progress item (tears down any worktree)")
      .option("--yes", "Skip the confirmation prompt when cancelling would discard unmerged work"),
  ).action(async (id: string, opts: Record<string, unknown>) => {
    await runCommand(deps.cancelCommand, toParsedArgs([id], opts, "cancel"));
  });

  // ── complete ─────────────────────────────────────────────────────────────
  withJson(
    program
      .command("complete <token>")
      .summary("[mutates] Complete a claimed item")
      .option("--agent <name>", "Agent name (must match the claim)")
      .option("--result <text>", "Attach a result summary"),
  ).action(async (token: string, opts: Record<string, unknown>) => {
    await runCommand(deps.completeCommand, toParsedArgs([token], opts, "complete"));
  });

  // ── requeue ──────────────────────────────────────────────────────────────
  withJson(
    program
      .command("requeue <id>")
      .summary("[mutates] Return an in-progress item to the queue")
      .option("--reason <text>", "Why the item is being requeued")
      .option("--agent <name>", "Agent name (must match the claim)"),
  ).action(async (id: string, opts: Record<string, unknown>) => {
    await runCommand(deps.requeueCommand, toParsedArgs([id], opts, "requeue"));
  });

  // ── edit ─────────────────────────────────────────────────────────────────
  withJson(
    program
      .command("edit <id>")
      .summary("[mutates] Edit a queued/scheduled item's priority")
      .requiredOption("--priority <level>", "New priority: high, normal, or low"),
  ).action(async (id: string, opts: Record<string, unknown>) => {
    await runCommand(deps.editCommand, toParsedArgs([id], opts, "edit"));
  });

  // ── integrate ────────────────────────────────────────────────────────────
  withJson(
    program
      .command("integrate <id>")
      .summary("[mutates with --apply] Merge an item's branch into main and clean up its worktree")
      .option("--apply", "Execute the merge (previews the git commands by default)")
      .option("--dry-run", "Deprecated: preview is the default; accepted as a no-op")
      .option("--keep-worktree", "Leave the worktree and branch after merge"),
  )
    .addHelpText(
      "after",
      "\nExamples:\n" +
        "  hopper integrate a3f8            # preview the merge, no changes\n" +
        "  hopper integrate a3f8 --apply    # execute the merge and clean up",
    )
    .action(async (id: string, opts: Record<string, unknown>) => {
      const git = createGitGateway();
      await runCommand((p) => deps.integrateCommand(p, git), toParsedArgs([id], opts, "integrate"));
    });

  // ── audit ────────────────────────────────────────────────────────────────
  withJson(
    program
      .command("audit <id>")
      .summary("Show the audit trail for an item")
      .option("--tail <n>", "Last N decoded session events")
      .option("--plan", "Show the engineering plan")
      .option("--result", "Show the final result")
      .option("--phase <name>", "Restrict to one phase (engineering only)"),
  ).action(async (id: string, opts: Record<string, unknown>) => {
    const audit = createAuditGateway();
    await runCommand((p) => deps.auditCommand(p, audit), toParsedArgs([id], opts, "audit"));
  });

  // ── show ─────────────────────────────────────────────────────────────────
  withJson(program.command("show <id>").summary("Show full details of an item")).action(
    async (id: string, opts: Record<string, unknown>) => {
      const audit = createAuditGateway();
      await runCommand((p) => deps.showCommand(p, audit), toParsedArgs([id], opts, "show"));
    },
  );

  // ── tag / untag ──────────────────────────────────────────────────────────
  withJson(
    program.command("tag <id> <tags...>").summary("[mutates] Add tags to an existing item"),
  ).action(async (id: string, tags: string[], opts: Record<string, unknown>) => {
    await runCommand(deps.tagCommand, toParsedArgs([id, ...tags], opts, "tag"));
  });

  withJson(
    program.command("untag <id> <tags...>").summary("[mutates] Remove tags from an existing item"),
  ).action(async (id: string, tags: string[], opts: Record<string, unknown>) => {
    await runCommand(deps.untagCommand, toParsedArgs([id, ...tags], opts, "untag"));
  });

  // ── preset ───────────────────────────────────────────────────────────────
  const preset = program.command("preset").summary("Manage reusable item templates");

  withJson(
    preset
      .command("add <name> <description>")
      .summary("[mutates] Save a reusable template")
      .option("--dir <path>", "Working directory baked into the preset")
      .option("--branch <branch>", "Git branch baked into the preset")
      .option("--command <cmd>", "Shell command baked into the preset")
      .option("--type <type>", "Task type baked into the preset")
      .option("--agent <name>", "Agent baked into the preset")
      .option("--retries <n>", "Retry budget baked into the preset"),
  ).action(async (name: string, description: string, opts: Record<string, unknown>) => {
    await runCommand(deps.presetCommand, toParsedArgs(["add", name, description], opts, "preset"));
  });

  withJson(preset.command("list").summary("List saved presets")).action(
    async (opts: Record<string, unknown>) => {
      await runCommand(deps.presetCommand, toParsedArgs(["list"], opts, "preset"));
    },
  );

  withJson(preset.command("remove <name>").summary("[mutates] Delete a preset")).action(
    async (name: string, opts: Record<string, unknown>) => {
      await runCommand(deps.presetCommand, toParsedArgs(["remove", name], opts, "preset"));
    },
  );

  withJson(preset.command("show <name>").summary("Show preset details")).action(
    async (name: string, opts: Record<string, unknown>) => {
      await runCommand(deps.presetCommand, toParsedArgs(["show", name], opts, "preset"));
    },
  );

  // ── profiles ─────────────────────────────────────────────────────────────
  const profiles = program.command("profiles").summary("List installed profiles");
  const runProfiles = (positional: string[], opts: Record<string, unknown>) => {
    const profilesGateway = createProfilesGateway();
    return runCommand(
      (p) => deps.profilesCommand(p, profilesGateway),
      toParsedArgs(positional, opts, "profiles"),
    );
  };
  withJson(profiles).action(async (opts: Record<string, unknown>) => {
    // Bare `hopper profiles` lists; a subcommand overrides this.
    await runProfiles([], opts);
  });
  withJson(profiles.command("show <name>").summary("Print a profile file's contents")).action(
    async (name: string, opts: Record<string, unknown>) => {
      await runProfiles(["show", name], opts);
    },
  );

  // ── worker ───────────────────────────────────────────────────────────────
  program
    .command("worker")
    .summary("Run the worker loop (runner-agnostic; each item dispatches per its profile)")
    .option("--once", "Process one item then exit")
    .option("--agent <name>", "Agent name (default: worker)")
    .option("--interval <sec>", "Poll interval in seconds (default: 60)")
    .option("--concurrency <n>", "Run up to N items in parallel (default: 4)")
    // Deprecated: kept so `workerCommand` can emit the precise removal notice
    // rather than commander's generic "unknown option" error.
    .option("--runner <name>", "Removed in 3.0.0 — runner selection is now per-item via profiles")
    .action(async (opts: Record<string, unknown>) => {
      await deps.workerCommand(toParsedArgs([], opts, "worker"));
    });

  // ── init ─────────────────────────────────────────────────────────────────
  program
    .command("init")
    .summary("Install the hopper Claude Code skill (companion skill)")
    .description("Install or remove the hopper-coordinator skill for Claude Code.")
    .option("--global", "Install/remove in ~/.claude/skills (default)")
    .option("--local", "Install/remove in ./.claude/skills")
    .option("--remove", "Uninstall the coordinator skill for the chosen scope")
    .option("--force", "Force a reinstall/downgrade")
    .option("--json", "Output as JSON")
    .action(async (opts: Record<string, unknown>) => {
      const { initCommand } = await import("./commands/init.ts");
      if (opts.global === true && opts.local === true) {
        console.error("Use either --global or --local, not both.");
        process.exit(1);
      }
      await initCommand({
        jsonOutput: opts.json === true,
        scope: opts.local === true ? "local" : "global",
        force: opts.force === true,
        remove: opts.remove === true,
      });
    });

  return program;
}

async function main(): Promise<void> {
  const program = buildProgram();
  // No arguments → show help (exit 0), matching prior friendly behaviour.
  if (process.argv.slice(2).length === 0) {
    program.outputHelp();
    return;
  }
  await program.parseAsync(process.argv);
}

// Only drive the CLI when executed as the entry point — importing this module
// (e.g. from tests, to build the program with spy deps) must not parse argv.
if (import.meta.main) {
  main();
}
