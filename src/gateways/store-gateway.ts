import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Item } from "../store.ts";
import { ensureDefaults } from "../store-workflow.ts";

export interface StoreGateway {
  load(): Promise<Item[]>;
  save(items: Item[]): Promise<void>;
}

export function createStoreGateway(storeDir?: string): StoreGateway {
  const dir = storeDir ?? join(homedir(), ".hopper");
  const filePath = join(dir, "items.json");

  return {
    async load(): Promise<Item[]> {
      try {
        const file = Bun.file(filePath);
        if (await file.exists()) {
          const raw: unknown[] = await file.json();
          return raw.map((entry) => ensureDefaults(entry as Record<string, unknown>));
        }
      } catch {
        // Corrupted or unreadable — start fresh
      }
      return [];
    },
    async save(items: Item[]): Promise<void> {
      await mkdir(dir, { recursive: true });
      await Bun.write(filePath, `${JSON.stringify(items, null, 2)}\n`);
    },
  };
}
