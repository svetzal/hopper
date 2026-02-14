import { mkdir } from "fs/promises";
import { homedir } from "os";
import { join } from "path";

export interface Item {
  id: string;
  title: string;
  description: string;
  createdAt: string;
}

const DEFAULT_STORE_DIR = join(homedir(), ".hopper");
const ITEMS_FILE = "items.json";

let storeDir = DEFAULT_STORE_DIR;

export function setStoreDir(dir: string): void {
  storeDir = dir;
}

export function getStorePath(): string {
  return join(storeDir, ITEMS_FILE);
}

export async function loadItems(): Promise<Item[]> {
  try {
    const file = Bun.file(getStorePath());
    if (await file.exists()) {
      return await file.json();
    }
  } catch {
    // Corrupted or unreadable — start fresh
  }
  return [];
}

export async function saveItems(items: Item[]): Promise<void> {
  await mkdir(storeDir, { recursive: true });
  await Bun.write(getStorePath(), JSON.stringify(items, null, 2) + "\n");
}

export async function addItem(item: Item): Promise<void> {
  const items = await loadItems();
  items.unshift(item);
  await saveItems(items);
}
