import { formatValidationError, validateRetries, validateTaskType } from "../add-workflow.ts";
import type { ParsedArgs } from "../cli.ts";
import { requirePositional, stringFlag } from "../command-flags.ts";
import type { CommandResult } from "../command-result.ts";
import { toErrorMessage } from "../error-utils.ts";
import {
  addPreset,
  findPreset,
  loadPresets,
  removePreset,
  validatePresetName,
} from "../presets.ts";

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

async function presetAddCommand(parsed: ParsedArgs): Promise<CommandResult> {
  const rawName = parsed.positional[1];
  const description = parsed.positional[2];

  if (!rawName || !description) {
    return {
      status: "error",
      message:
        "Usage: hopper preset add <name> <description> [--dir <path>] [--branch <branch>] [--command <cmd>] [--type <type>] [--agent <name>] [--retries <n>]",
    };
  }

  let name: string;
  try {
    name = validatePresetName(rawName);
  } catch (err) {
    return { status: "error", message: toErrorMessage(err) };
  }

  const dir = stringFlag(parsed, "dir");
  const branch = stringFlag(parsed, "branch");
  const command = stringFlag(parsed, "command");
  const agent = stringFlag(parsed, "agent");
  const typeResult = validateTaskType(stringFlag(parsed, "type"));
  if ("error" in typeResult) {
    return { status: "error", message: formatValidationError(typeResult.error) };
  }
  const type = typeResult.value;
  const retriesResult = validateRetries(stringFlag(parsed, "retries"));
  if ("error" in retriesResult) {
    return { status: "error", message: formatValidationError(retriesResult.error) };
  }
  const retries = retriesResult.value;
  const force = parsed.flags.force === true;

  try {
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
    );
  } catch (err) {
    return { status: "error", message: toErrorMessage(err) };
  }

  const preset = await findPreset(name);

  return {
    status: "success",
    data: preset,
    humanOutput: `Preset saved: ${name}`,
  };
}

async function presetListCommand(_parsed: ParsedArgs): Promise<CommandResult> {
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

async function presetRemoveCommand(parsed: ParsedArgs): Promise<CommandResult> {
  const nameArg = requirePositional(parsed, 1, "Usage: hopper preset remove <name>");
  if (!nameArg.ok) return nameArg.result;
  const name = nameArg.value;

  await removePreset(name);

  return {
    status: "success",
    data: { removed: name.toLowerCase() },
    humanOutput: `Preset removed: ${name.toLowerCase()}`,
  };
}

async function presetShowCommand(parsed: ParsedArgs): Promise<CommandResult> {
  const nameArg = requirePositional(parsed, 1, "Usage: hopper preset show <name>");
  if (!nameArg.ok) return nameArg.result;
  const name = nameArg.value;

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
}
