import { homedir } from "node:os";
import { join } from "node:path";
import type { ItemStatus, TaskType } from "./constants.ts";
import { createStoreGateway, type StoreGateway } from "./gateways/store-gateway.ts";
import {
  addTags,
  appendPhase,
  cancel,
  claimNext,
  complete,
  prependItem,
  removeTags,
  reprioritize,
  requeue,
  resolveItem,
} from "./store-workflow.ts";

/**
 * Per-phase runtime record for an engineering item.
 *
 * Written to the item as each phase finishes so `hopper show` can report
 * mid-flight progress (e.g. "plan ✓ 34s / execute ✗ FAIL") without having to
 * replay the per-phase audit JSONL files.
 */
export type PhaseName = "plan" | "execute" | "validate";

export interface PhaseRecord {
  name: PhaseName;
  startedAt: string;
  endedAt: string;
  exitCode: number;
  /** Validate-phase PASS/FAIL marker. Undefined for plan / execute. */
  passed?: boolean;
  /**
   * 1-based attempt number. Undefined / 1 = first attempt. Values > 1 indicate
   * a remediation retry after a prior validate phase failed. Only the execute
   * and validate phases ever run more than once per item.
   */
  attempt?: number;
}

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
  /**
   * Task type — determines which workflow the worker runs for this item.
   * Undefined is treated as the legacy "task" workflow (preserves prior behaviour).
   */
  type?: TaskType;
  /**
   * Craftsperson/agent to pass via `--agent` when the worker runs Claude.
   * Undefined means no agent is selected (default Claude behaviour).
   */
  agent?: string;
  /**
   * Per-phase runtime records for engineering items. Written incrementally as
   * each phase completes, so `hopper show` can render in-flight progress.
   */
  phases?: PhaseRecord[];
  /**
   * Maximum number of execute→validate remediation retries after the initial
   * pass fails validation. 0 = no retries (single execute+validate). Only
   * engineering items consult this; defaults to 1 when unset.
   */
  retries?: number;
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
  if (!outcome.ok) throw new Error(outcome.error);
  await saveItems(outcome.value.items);
  return { completed: outcome.value.completed, recurred: outcome.value.recurred };
}

export async function findItem(id: string): Promise<Item> {
  const items = await loadItems();
  const result = resolveItem(items, id);
  if (!result.ok) throw new Error(result.error);
  return result.value;
}

export async function requeueItem(id: string, reason: string, agent?: string): Promise<Item> {
  const items = await loadItems();
  const outcome = requeue(items, id, reason, agent);
  if (!outcome.ok) throw new Error(outcome.error);
  await saveItems(outcome.value.items);
  return outcome.value.requeued;
}

export interface CancelResult {
  item: Item;
  blockedDependentCount: number;
}

export async function cancelItem(id: string): Promise<CancelResult> {
  const items = await loadItems();
  const outcome = cancel(items, id, new Date());
  if (!outcome.ok) throw new Error(outcome.error);
  await saveItems(outcome.value.items);
  return { item: outcome.value.cancelled, blockedDependentCount: outcome.value.blockedDependentCount };
}

export async function updateItemTags(id: string, tags: string[]): Promise<Item> {
  const items = await loadItems();
  const outcome = addTags(items, id, tags);
  if (!outcome.ok) throw new Error(outcome.error);
  await saveItems(outcome.value.items);
  return outcome.value.item;
}

export async function removeItemTags(id: string, tags: string[]): Promise<Item> {
  const items = await loadItems();
  const outcome = removeTags(items, id, tags);
  if (!outcome.ok) throw new Error(outcome.error);
  await saveItems(outcome.value.items);
  return outcome.value.item;
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
  if (!outcome.ok) throw new Error(outcome.error);
  await saveItems(outcome.value.items);
  return { item: outcome.value.item, oldPriority: outcome.value.oldPriority };
}

/**
 * Append a phase record to an engineering item. Called mid-flight by the
 * worker after each phase finishes so `hopper show` reflects current progress.
 * Silently no-ops if the item is not found — phase recording is a visibility
 * aid, not a correctness-critical path.
 */
export async function recordItemPhase(id: string, record: PhaseRecord): Promise<void> {
  const items = await loadItems();
  const outcome = appendPhase(items, id, record);
  if (outcome.changed) {
    await saveItems(outcome.items);
  }
}
