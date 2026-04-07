import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Item } from "../store.ts";
import { ensureDefaults } from "../store-workflow.ts";
import { loadJsonFile } from "./json-file.ts";

export interface StoreGateway {
  load(): Promise<Item[]>;
  save(items: Item[]): Promise<void>;
}

export function createStoreGateway(storeDir?: string): StoreGateway {
  const dir = storeDir ?? join(homedir(), ".hopper");
  const filePath = join(dir, "items.json");

  return {
    async load(): Promise<Item[]> {
      return loadJsonFile<Item>(filePath, (raw) =>
        raw.map((entry) => ensureDefaults(entry as Record<string, unknown>)),
      );
    },
    async save(items: Item[]): Promise<void> {
      await mkdir(dir, { recursive: true });
      await Bun.write(filePath, `${JSON.stringify(items, null, 2)}\n`);
    },
  };
}
