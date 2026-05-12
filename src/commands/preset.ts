import { formatValidationError, validateRetries, validateTaskType } from "../add-workflow.ts";
import type { ParsedArgs } from "../cli.ts";
import { stringFlag, unwrapPositional } from "../command-flags.ts";
import type { CommandResult } from "../command-result.ts";
import type { Preset } from "../presets.ts";
import {
  addPreset,
  findPreset,
  loadPresets,
  removePreset,
  validatePresetName,
} from "../presets.ts";
import { catchCommandError, unwrap } from "../result.ts";

export async function presetCommand(parsed: ParsedArgs): Promise<CommandResult> {
  const subcommand = parsed.positional[0];

  switch (subcommand) {
    case "add":
      return presetAddCommand(parsed);
    case "list":
      return presetListCommand(parsed);
    case "remove":
      return presetRemoveCommand(parsed);
    case "show":
      return presetShowCommand(parsed);
    default:
      return { status: "error", message: "Usage: hopper preset <add|list|remove|show>" };
  }
}

async function presetAddCommand(parsed: ParsedArgs): Promise<CommandResult<Preset | undefined>> {
  return catchCommandError(async () => {
    const rawName = parsed.positional[1];
    const description = parsed.positional[2];

    if (!rawName || !description) {
      return {
        status: "error",
        message:
          "Usage: hopper preset add <name> <description> [--dir <path>] [--branch <branch>] [--command <cmd>] [--type <type>] [--agent <name>] [--retries <n>]",
      };
    }

    const name = unwrap(validatePresetName(rawName));
    const dir = stringFlag(parsed, "dir");
    const branch = stringFlag(parsed, "branch");
    const command = stringFlag(parsed, "command");
    const agent = stringFlag(parsed, "agent");
    const type = unwrap(validateTaskType(stringFlag(parsed, "type")), formatValidationError);
    const retries = unwrap(validateRetries(stringFlag(parsed, "retries")), formatValidationError);
    const force = parsed.flags.force === true;

    unwrap(
      await addPreset(
        {
          name,
          description,
          ...(dir ? { workingDir: dir } : {}),
          ...(branch ? { branch } : {}),
          ...(command ? { command } : {}),
          ...(type ? { type } : {}),
          ...(agent ? { agent } : {}),
          ...(retries !== undefined ? { retries } : {}),
          createdAt: new Date().toISOString(),
        },
        force,
      ),
    );

    const preset = await findPreset(name);

    return {
      status: "success",
      data: preset,
      humanOutput: `Preset saved: ${name}`,
    };
  });
}

async function presetListCommand(_parsed: ParsedArgs): Promise<CommandResult<Preset[]>> {
  const presets = await loadPresets();

  if (presets.length === 0) {
    return {
      status: "success",
      data: [],
      humanOutput: "No presets saved.",
    };
  }

  const lines: string[] = [];
  for (const preset of presets) {
    const snippet =
      preset.description.length > 60
        ? `${preset.description.slice(0, 60).trim()}...`
        : preset.description;
    const extras: string[] = [];
    if (preset.type) extras.push(`type: ${preset.type}`);
    if (preset.agent) extras.push(`agent: ${preset.agent}`);
    if (preset.retries !== undefined) extras.push(`retries: ${preset.retries}`);
    if (preset.workingDir) extras.push(`dir: ${preset.workingDir}`);
    if (preset.branch) extras.push(`branch: ${preset.branch}`);
    if (preset.command) extras.push(`command: ${preset.command}`);
    const extraStr = extras.length > 0 ? `  (${extras.join(", ")})` : "";
    lines.push(`  ${preset.name}${extraStr}`);
    lines.push(`    ${snippet}`);
    lines.push("");
  }

  // Remove the trailing empty line so console.log doesn't add double newline
  if (lines[lines.length - 1] === "") {
    lines.pop();
  }

  return {
    status: "success",
    data: presets,
    humanOutput: lines.join("\n"),
  };
}

async function presetRemoveCommand(
  parsed: ParsedArgs,
): Promise<CommandResult<{ removed: string }>> {
  return catchCommandError(async () => {
    const name = unwrapPositional(parsed, 1, "Usage: hopper preset remove <name>");
    unwrap(await removePreset(name));
    return {
      status: "success",
      data: { removed: name.toLowerCase() },
      humanOutput: `Preset removed: ${name.toLowerCase()}`,
    };
  });
}

async function presetShowCommand(parsed: ParsedArgs): Promise<CommandResult<Preset>> {
  return catchCommandError(async () => {
    const name = unwrapPositional(parsed, 1, "Usage: hopper preset show <name>");

    const preset = await findPreset(name);
    if (!preset) {
      return { status: "error", message: `No preset found with name: ${name}` };
    }

    const lines: string[] = [];
    lines.push(`Name:        ${preset.name}`);
    if (preset.type) lines.push(`Type:        ${preset.type}`);
    if (preset.agent) lines.push(`Agent:       ${preset.agent}`);
    if (preset.retries !== undefined) lines.push(`Retries:     ${preset.retries}`);
    if (preset.workingDir) lines.push(`Directory:   ${preset.workingDir}`);
    if (preset.branch) lines.push(`Branch:      ${preset.branch}`);
    if (preset.command) lines.push(`Command:     ${preset.command}`);
    lines.push(`Created:     ${preset.createdAt}`);
    lines.push("");
    lines.push("Description:");
    lines.push(`  ${preset.description}`);

    return {
      status: "success",
      data: preset,
      humanOutput: lines.join("\n"),
    };
  });
}
