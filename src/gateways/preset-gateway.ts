import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Preset } from "../presets.ts";

export interface PresetGateway {
  load(): Promise<Preset[]>;
  save(presets: Preset[]): Promise<void>;
}

export function createPresetGateway(storeDir?: string): PresetGateway {
  const dir = storeDir ?? join(homedir(), ".hopper");
  const filePath = join(dir, "presets.json");

  return {
    async load(): Promise<Preset[]> {
      try {
        const file = Bun.file(filePath);
        if (await file.exists()) {
          return (await file.json()) as Preset[];
        }
      } catch {
        // Corrupted or unreadable — start fresh
      }
      return [];
    },
    async save(presets: Preset[]): Promise<void> {
      await mkdir(dir, { recursive: true });
      await Bun.write(filePath, `${JSON.stringify(presets, null, 2)}\n`);
    },
  };
}
