import { homedir } from "node:os";
import { join } from "node:path";
import type { ItemStatus } from "./constants.ts";
import { createStoreGateway, type StoreGateway } from "./gateways/store-gateway.ts";
import {
  addTags,
  cancel,
  claimNext,
  complete,
  prependItem,
  removeTags,
  reprioritize,
  requeue,
  resolveItem,
} from "./store-workflow.ts";

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
  priority?: "high" | "normal" | "low";
  requeueReason?: string;
  requeuedBy?: string;
  cancelledAt?: string;
  scheduledAt?: string;
  workingDir?: string;
  branch?: string;
  command?: string;
  tags?: string[];
  dependsOn?: string[];
  recurrence?: {
    interval: string;
    intervalMs: number;
    until?: string;
    remainingRuns?: number;
  };
}

export type ClaimedItem = Item & {
  status: "in_progress";
  claimedAt: string;
  claimedBy?: string;
  claimToken: string;
};

const DEFAULT_STORE_DIR = join(homedir(), ".hopper");
const ITEMS_FILE = "items.json";

let currentStoreDir: string = DEFAULT_STORE_DIR;
let gateway: StoreGateway = createStoreGateway();

export function setStoreDir(dir: string): void {
  currentStoreDir = dir;
  gateway = createStoreGateway(dir);
}

export function getStorePath(): string {
  return join(currentStoreDir, ITEMS_FILE);
}

export async function loadItems(): Promise<Item[]> {
  return gateway.load();
}

export async function saveItems(items: Item[]): Promise<void> {
  return gateway.save(items);
}

export async function addItem(item: Item): Promise<void> {
  const items = await loadItems();
  await saveItems(prependItem(items, item));
}

export async function claimNextItem(agent?: string): Promise<ClaimedItem | undefined> {
  const items = await loadItems();
  const result = claimNext(items, agent, new Date(), crypto.randomUUID(), process.cwd());
  if (result.claimed) {
    await saveItems(result.items);
  }
  return result.claimed;
}

export interface CompleteResult {
  completed: Item;
  recurred?: Item;
}

export async function completeItem(
  token: string,
  agent?: string,
  result?: string,
): Promise<CompleteResult> {
  const items = await loadItems();
  const outcome = complete(items, token, agent, result, new Date(), crypto.randomUUID());
  await saveItems(outcome.items);
  return { completed: outcome.completed, recurred: outcome.recurred };
}

export async function findItem(id: string): Promise<Item> {
  const items = await loadItems();
  return resolveItem(items, id);
}

export async function requeueItem(id: string, reason: string, agent?: string): Promise<Item> {
  const items = await loadItems();
  const outcome = requeue(items, id, reason, agent);
  await saveItems(outcome.items);
  return outcome.requeued;
}

export interface CancelResult {
  item: Item;
  blockedDependentCount: number;
}

export async function cancelItem(id: string): Promise<CancelResult> {
  const items = await loadItems();
  const outcome = cancel(items, id, new Date());
  await saveItems(outcome.items);
  return { item: outcome.cancelled, blockedDependentCount: outcome.blockedDependentCount };
}

export async function updateItemTags(id: string, tags: string[]): Promise<Item> {
  const items = await loadItems();
  const outcome = addTags(items, id, tags);
  await saveItems(outcome.items);
  return outcome.item;
}

export async function removeItemTags(id: string, tags: string[]): Promise<Item> {
  const items = await loadItems();
  const outcome = removeTags(items, id, tags);
  await saveItems(outcome.items);
  return outcome.item;
}

export interface ReprioritizeResult {
  item: Item;
  oldPriority: string;
}

export async function reprioritizeItem(
  id: string,
  priority: "high" | "normal" | "low",
): Promise<ReprioritizeResult> {
  const items = await loadItems();
  const outcome = reprioritize(items, id, priority);
  await saveItems(outcome.items);
  return { item: outcome.item, oldPriority: outcome.oldPriority };
}
