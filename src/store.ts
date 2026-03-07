// mkdir is the one Node.js stdlib import — Bun.write() does not create parent directories
import { mkdir } from "fs/promises";
import { homedir } from "os";
import { join } from "path";
import { Status } from "./constants.ts";
import type { ItemStatus } from "./constants.ts";

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
  priority?: 'high' | 'normal' | 'low';
  requeueReason?: string;
  requeuedBy?: string;
  cancelledAt?: string;
  scheduledAt?: string;
  workingDir?: string;
  branch?: string;
  tags?: string[];
  dependsOn?: string[];
  recurrence?: {
    interval: string;
    intervalMs: number;
    until?: string;
  };
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
          item.status = Status.QUEUED;
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
  const now = new Date();
  const queued = items
    .filter((i) => {
      if (i.status === Status.QUEUED) return true;
      if (i.status === Status.SCHEDULED && i.scheduledAt && new Date(i.scheduledAt) <= now) return true;
      return false;
    })
    .sort((a, b) => {
      const priorityOrder = { high: 0, normal: 1, low: 2 };
      const pa = priorityOrder[a.priority ?? 'normal'];
      const pb = priorityOrder[b.priority ?? 'normal'];
      if (pa !== pb) return pa - pb;
      return new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime();
    });

  const next = queued[0];
  if (!next) return null;

  next.status = Status.IN_PROGRESS;
  next.claimedAt = new Date().toISOString();
  next.claimedBy = agent;
  next.claimToken = crypto.randomUUID();

  await saveItems(items);
  return next;
}

export interface CompleteResult {
  completed: Item;
  recurred?: Item;
}

export async function completeItem(token: string, agent?: string, result?: string): Promise<CompleteResult> {
  const items = await loadItems();
  const item = items.find((i) => i.claimToken === token);

  if (!item) {
    throw new Error(`No in-progress item found with token: ${token}`);
  }
  if (item.status !== Status.IN_PROGRESS) {
    throw new Error(`Item is not in progress (status: ${item.status})`);
  }

  item.status = Status.COMPLETED;
  item.completedAt = new Date().toISOString();
  item.completedBy = agent;
  item.result = result;
  item.claimToken = undefined;

  // Unblock items that depended on this completed item
  for (const blocked of items.filter(i => i.status === Status.BLOCKED)) {
    const allDepsComplete = (blocked.dependsOn ?? []).every(depId =>
      items.find(i => i.id === depId)?.status === Status.COMPLETED
    );
    if (allDepsComplete) {
      blocked.status = blocked.scheduledAt ? Status.SCHEDULED : Status.QUEUED;
    }
  }

  let recurredItem: Item | undefined;
  if (item.recurrence) {
    const now = Date.now();
    const untilExpired = item.recurrence.until && new Date(item.recurrence.until).getTime() <= now;
    if (!untilExpired) {
      recurredItem = {
        id: crypto.randomUUID(),
        title: item.title,
        description: item.description,
        status: Status.SCHEDULED,
        createdAt: new Date().toISOString(),
        scheduledAt: new Date(now + item.recurrence.intervalMs).toISOString(),
        recurrence: { ...item.recurrence },
        ...(item.priority ? { priority: item.priority } : {}),
        ...(item.workingDir ? { workingDir: item.workingDir } : {}),
        ...(item.branch ? { branch: item.branch } : {}),
        ...(item.tags?.length ? { tags: [...item.tags] } : {}),
      };
      items.unshift(recurredItem);
    }
  }

  await saveItems(items);
  return { completed: item, recurred: recurredItem };
}

function resolveItem(items: Item[], id: string): Item {
  const matches = items.filter((i) => i.id === id || i.id.startsWith(id));

  if (matches.length === 0) {
    throw new Error(`No item found with id: ${id}`);
  }
  if (matches.length > 1) {
    throw new Error(`Ambiguous id prefix "${id}" matches ${matches.length} items. Use a longer prefix.`);
  }

  return matches[0]!;
}

export async function findItem(id: string): Promise<Item> {
  const items = await loadItems();
  return resolveItem(items, id);
}

export async function requeueItem(id: string, reason: string, agent?: string): Promise<Item> {
  const items = await loadItems();
  const item = resolveItem(items, id);
  if (item.status !== Status.IN_PROGRESS) {
    throw new Error(`Item is not in progress (status: ${item.status})`);
  }

  item.status = Status.QUEUED;
  item.claimedAt = undefined;
  item.claimedBy = undefined;
  item.claimToken = undefined;
  item.requeueReason = reason;
  item.requeuedBy = agent;

  await saveItems(items);
  return item;
}

export interface CancelResult {
  item: Item;
  blockedDependentCount: number;
}

export async function cancelItem(id: string): Promise<CancelResult> {
  const items = await loadItems();
  const item = resolveItem(items, id);
  if (item.status !== Status.QUEUED && item.status !== Status.SCHEDULED && item.status !== Status.BLOCKED) {
    throw new Error(`Cannot cancel item — status is "${item.status}". Only queued, scheduled, or blocked items can be cancelled.`);
  }

  item.status = Status.CANCELLED;
  item.cancelledAt = new Date().toISOString();

  const blockedDependentCount = items.filter(i =>
    i.status === Status.BLOCKED && (i.dependsOn ?? []).includes(item.id)
  ).length;

  await saveItems(items);
  return { item, blockedDependentCount };
}

export async function updateItemTags(id: string, tags: string[]): Promise<Item> {
  const items = await loadItems();
  const item = resolveItem(items, id);
  const merged = [...new Set([...(item.tags ?? []), ...tags])].sort();
  item.tags = merged;
  await saveItems(items);
  return item;
}

export async function removeItemTags(id: string, tags: string[]): Promise<Item> {
  const items = await loadItems();
  const item = resolveItem(items, id);
  const tagSet = new Set(tags);
  item.tags = (item.tags ?? []).filter((t) => !tagSet.has(t));
  if (item.tags.length === 0) item.tags = undefined;
  await saveItems(items);
  return item;
}

export interface ReprioritizeResult {
  item: Item;
  oldPriority: string;
}

export async function reprioritizeItem(id: string, priority: 'high' | 'normal' | 'low'): Promise<ReprioritizeResult> {
  const items = await loadItems();
  const item = resolveItem(items, id);
  if (item.status !== Status.QUEUED && item.status !== Status.SCHEDULED) {
    throw new Error(`Cannot reprioritize item — status is "${item.status}". Only queued or scheduled items can be reprioritized.`);
  }

  const oldPriority = item.priority ?? 'normal';
  item.priority = priority;

  await saveItems(items);
  return { item, oldPriority };
}
