import type { ParsedArgs } from "../cli.ts";
import {
  addPreset,
  findPreset,
  loadPresets,
  removePreset,
  validatePresetName,
} from "../presets.ts";

export async function presetCommand(parsed: ParsedArgs): Promise<void> {
  const subcommand = parsed.positional[0];

  switch (subcommand) {
    case "add":
      await presetAddCommand(parsed);
      break;
    case "list":
      await presetListCommand(parsed);
      break;
    case "remove":
      await presetRemoveCommand(parsed);
      break;
    case "show":
      await presetShowCommand(parsed);
      break;
    default:
      console.error("Usage: hopper preset <add|list|remove|show>");
      process.exit(1);
  }
}

async function presetAddCommand(parsed: ParsedArgs): Promise<void> {
  const rawName = parsed.positional[1];
  const description = parsed.positional[2];

  if (!rawName || !description) {
    console.error("Usage: hopper preset add <name> <description> [--dir <path>] [--branch <branch>]");
    process.exit(1);
  }

  let name: string;
  try {
    name = validatePresetName(rawName);
  } catch (err) {
    console.error((err as Error).message);
    process.exit(1);
  }

  const dir = typeof parsed.flags.dir === "string" ? parsed.flags.dir : undefined;
  const branch = typeof parsed.flags.branch === "string" ? parsed.flags.branch : undefined;
  const force = parsed.flags.force === true;

  try {
    await addPreset(
      {
        name,
        description,
        ...(dir ? { workingDir: dir } : {}),
        ...(branch ? { branch } : {}),
        createdAt: new Date().toISOString(),
      },
      force
    );
  } catch (err) {
    console.error((err as Error).message);
    process.exit(1);
  }

  if (parsed.flags.json === true) {
    const preset = await findPreset(name);
    console.log(JSON.stringify(preset, null, 2));
  } else {
    console.log(`Preset saved: ${name}`);
  }
}

async function presetListCommand(parsed: ParsedArgs): Promise<void> {
  const presets = await loadPresets();

  if (presets.length === 0) {
    console.log("No presets saved.");
    return;
  }

  if (parsed.flags.json === true) {
    console.log(JSON.stringify(presets, null, 2));
    return;
  }

  for (const preset of presets) {
    const snippet =
      preset.description.length > 60
        ? preset.description.slice(0, 60).trim() + "..."
        : preset.description;
    const extras: string[] = [];
    if (preset.workingDir) extras.push(`dir: ${preset.workingDir}`);
    if (preset.branch) extras.push(`branch: ${preset.branch}`);
    const extraStr = extras.length > 0 ? `  (${extras.join(", ")})` : "";
    console.log(`  ${preset.name}${extraStr}`);
    console.log(`    ${snippet}`);
    console.log();
  }
}

async function presetRemoveCommand(parsed: ParsedArgs): Promise<void> {
  const name = parsed.positional[1];
  if (!name) {
    console.error("Usage: hopper preset remove <name>");
    process.exit(1);
  }

  try {
    await removePreset(name);
  } catch (err) {
    console.error((err as Error).message);
    process.exit(1);
  }

  if (parsed.flags.json === true) {
    console.log(JSON.stringify({ removed: name.toLowerCase() }));
  } else {
    console.log(`Preset removed: ${name.toLowerCase()}`);
  }
}

async function presetShowCommand(parsed: ParsedArgs): Promise<void> {
  const name = parsed.positional[1];
  if (!name) {
    console.error("Usage: hopper preset show <name>");
    process.exit(1);
  }

  const preset = await findPreset(name);
  if (!preset) {
    console.error(`No preset found with name: ${name}`);
    process.exit(1);
  }

  if (parsed.flags.json === true) {
    console.log(JSON.stringify(preset, null, 2));
    return;
  }

  console.log(`Name:        ${preset.name}`);
  if (preset.workingDir) console.log(`Directory:   ${preset.workingDir}`);
  if (preset.branch) console.log(`Branch:      ${preset.branch}`);
  console.log(`Created:     ${preset.createdAt}`);
  console.log();
  console.log(`Description:`);
  console.log(`  ${preset.description}`);
}
