import { mkdir } from "fs/promises";
import { homedir } from "os";
import { join } from "path";

export type ItemStatus = "queued" | "in_progress" | "completed";

export interface Item {
  id: string;
  title: string;
  description: string;
  status: ItemStatus;
  createdAt: string;
  claimedAt?: string;
  claimedBy?: string;
  claimToken?: string;
  completedAt?: string;
  completedBy?: string;
  result?: string;
  requeueReason?: string;
  requeuedBy?: string;
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
      const raw: unknown[] = await file.json();
      return raw.map((entry) => {
        const item = entry as Record<string, unknown>;
        if (!item.status) {
          item.status = "queued";
        }
        return item as unknown as Item;
      });
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

export async function claimNextItem(agent?: string): Promise<Item | null> {
  const items = await loadItems();
  const queued = items
    .filter((i) => i.status === "queued")
    .sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());

  const next = queued[0];
  if (!next) return null;

  next.status = "in_progress";
  next.claimedAt = new Date().toISOString();
  next.claimedBy = agent;
  next.claimToken = crypto.randomUUID();

  await saveItems(items);
  return next;
}

export async function completeItem(token: string, agent?: string, result?: string): Promise<Item> {
  const items = await loadItems();
  const item = items.find((i) => i.claimToken === token);

  if (!item) {
    throw new Error(`No in-progress item found with token: ${token}`);
  }
  if (item.status !== "in_progress") {
    throw new Error(`Item is not in progress (status: ${item.status})`);
  }

  item.status = "completed";
  item.completedAt = new Date().toISOString();
  item.completedBy = agent;
  item.result = result;
  item.claimToken = undefined;

  await saveItems(items);
  return item;
}

export async function requeueItem(id: string, reason: string, agent?: string): Promise<Item> {
  const items = await loadItems();
  const matches = items.filter((i) => i.id === id || i.id.startsWith(id));

  if (matches.length === 0) {
    throw new Error(`No item found with id: ${id}`);
  }
  if (matches.length > 1) {
    throw new Error(`Ambiguous id prefix "${id}" matches ${matches.length} items. Use a longer prefix.`);
  }

  const item = matches[0]!;
  if (item.status !== "in_progress") {
    throw new Error(`Item is not in progress (status: ${item.status})`);
  }

  item.status = "queued";
  item.claimedAt = undefined;
  item.claimedBy = undefined;
  item.claimToken = undefined;
  item.requeueReason = reason;
  item.requeuedBy = agent;

  await saveItems(items);
  return item;
}
