import { homedir } from "node:os";
import { join } from "node:path";
import type { Preset } from "../presets.ts";
import { loadJsonFile, saveJsonFile } from "./json-file.ts";

export interface PresetGateway {
  load(): Promise<Preset[]>;
  save(presets: Preset[]): Promise<void>;
}

export function createPresetGateway(storeDir?: string): PresetGateway {
  const dir = storeDir ?? join(homedir(), ".hopper");
  const filePath = join(dir, "presets.json");

  return {
    async load(): Promise<Preset[]> {
      return loadJsonFile<Preset>(filePath);
    },
    async save(presets: Preset[]): Promise<void> {
      await saveJsonFile(filePath, dir, presets);
    },
  };
}
