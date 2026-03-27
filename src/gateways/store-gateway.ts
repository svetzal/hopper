import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { Status } from "../constants.ts";
import type { Item } from "../store.ts";

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
          return raw.map((entry) => {
            const item = entry as Record<string, unknown>;
            if (!item.status) {
              item.status = Status.QUEUED;
            }
            return item as unknown as Item;
          });
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
