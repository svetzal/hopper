import { createPresetGateway, type PresetGateway } from "./gateways/preset-gateway.ts";

export interface Preset {
  name: string;
  description: string;
  workingDir?: string;
  branch?: string;
  command?: string;
  tags?: string[];
  createdAt: string;
}

let gateway: PresetGateway = createPresetGateway();

export function setPresetGateway(gw: PresetGateway): void {
  gateway = gw;
}

const NAME_PATTERN = /^[a-z0-9_-]+$/;
const MAX_NAME_LENGTH = 64;

export function validatePresetName(name: string): string {
  if (!name || name.length === 0) {
    throw new Error("Preset name cannot be empty");
  }
  if (name.length > MAX_NAME_LENGTH) {
    throw new Error(`Preset name must be ${MAX_NAME_LENGTH} characters or fewer`);
  }
  const normalized = name.toLowerCase();
  if (!NAME_PATTERN.test(normalized)) {
    throw new Error(
      "Preset name may only contain alphanumeric characters, hyphens, and underscores",
    );
  }
  return normalized;
}

export async function loadPresets(): Promise<Preset[]> {
  return gateway.load();
}

export async function savePresets(presets: Preset[]): Promise<void> {
  return gateway.save(presets);
}

export async function addPreset(preset: Preset, force = false): Promise<void> {
  const presets = await loadPresets();
  const existingIndex = presets.findIndex((p) => p.name === preset.name);
  if (existingIndex !== -1) {
    if (!force) {
      throw new Error(`Preset "${preset.name}" already exists (use --force to overwrite)`);
    }
    presets[existingIndex] = preset;
  } else {
    presets.push(preset);
  }
  await savePresets(presets);
}

export async function findPreset(name: string): Promise<Preset | undefined> {
  const presets = await loadPresets();
  const normalized = name.toLowerCase();
  return presets.find((p) => p.name === normalized);
}

export async function removePreset(name: string): Promise<Preset> {
  const presets = await loadPresets();
  const normalized = name.toLowerCase();
  const index = presets.findIndex((p) => p.name === normalized);
  if (index === -1) {
    throw new Error(`No preset found with name: ${name}`);
  }
  const removed = presets.splice(index, 1)[0] as Preset;
  await savePresets(presets);
  return removed;
}
