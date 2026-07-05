import { homedir } from "node:os";
import { join } from "node:path";
import type { ItemStatus, TaskType } from "./constants.ts";
import { createStoreGateway, type StoreGateway } from "./gateways/store-gateway.ts";
import { ok, type Result } from "./result.ts";
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
  setEngineeringBranchSlug,
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
  /**
   * True when the validate-phase outcome was resolved via the Haiku fallback
   * assessor (i.e. the agent forgot to emit a VALIDATE: PASS/FAIL marker).
   * Undefined / false for phases that resolved through the primary marker path.
   */
  fallbackUsed?: boolean;
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
   * Profile name baked at add-time. Identifies which `~/.hopper/profiles/<name>.json`
   * the worker loads to pick the runner (claude vs opencode) and resolve
   * model aliases. New in 3.0.0; items added before the profile rollout
   * fall back to `defaultProfile` from `~/.hopper/config.json` at claim
   * time.
   */
  profile?: string;
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
  /**
   * Cached branch slug for engineering items, generated once per item-lifetime
   * and persisted here so re-claims always produce the same
   * `hopper-eng/<slug>-<id-prefix>` work-branch name regardless of LLM
   * non-determinism.
   */
  engineeringBranchSlug?: string;
}

export type ClaimedItem = Item & {
  status: "in_progress";
  claimedAt: string;
  claimedBy?: string;
  claimToken: string;
};

export type EngineeringItem = ClaimedItem & { workingDir: string; branch: string };

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

async function transactConditional<R>(
  workflow: (items: Item[]) => { items: Item[]; changed: boolean; value: R },
): Promise<R> {
  const items = await loadItems();
  const outcome = workflow(items);
  if (outcome.changed) {
    await saveItems(outcome.items);
  }
  return outcome.value;
}

async function transact<W extends { items: Item[] }, T>(
  workflow: (items: Item[]) => Result<W>,
  map: (value: W) => T,
): Promise<Result<T>> {
  const items = await loadItems();
  const outcome = workflow(items);
  if (!outcome.ok) return outcome;
  await saveItems(outcome.value.items);
  return ok(map(outcome.value));
}

async function transactIfChanged(
  workflow: (items: Item[]) => { items: Item[]; changed: boolean },
): Promise<void> {
  await transactConditional((items) => ({ ...workflow(items), value: undefined }));
}

export async function addItem(item: Item): Promise<void> {
  await transactConditional((items) => ({
    items: prependItem(items, item),
    changed: true,
    value: undefined,
  }));
}

export async function claimNextItem(agent?: string): Promise<ClaimedItem | undefined> {
  return transactConditional((items) => {
    const result = claimNext(items, agent, new Date(), crypto.randomUUID(), process.cwd());
    return { items: result.items, changed: !!result.claimed, value: result.claimed };
  });
}

export interface CompleteResult {
  completed: Item;
  recurred?: Item;
}

export async function completeItem(
  token: string,
  agent?: string,
  result?: string,
): Promise<Result<CompleteResult>> {
  return transact(
    (items) => complete(items, token, agent, result, new Date(), crypto.randomUUID()),
    (v) => ({ completed: v.completed, recurred: v.recurred }),
  );
}

export async function findItem(id: string): Promise<Result<Item>> {
  const items = await loadItems();
  return resolveItem(items, id);
}

export async function requeueItem(
  id: string,
  reason: string,
  agent?: string,
): Promise<Result<Item>> {
  return transact(
    (items) => requeue(items, id, reason, agent),
    (v) => v.requeued,
  );
}

export interface CancelResult {
  item: Item;
  blockedDependentCount: number;
  previousStatus: ItemStatus;
}

export async function cancelItem(id: string): Promise<Result<CancelResult>> {
  return transact(
    (items) => cancel(items, id, new Date()),
    (v) => ({
      item: v.cancelled,
      blockedDependentCount: v.blockedDependentCount,
      previousStatus: v.previousStatus,
    }),
  );
}

export async function updateItemTags(id: string, tags: string[]): Promise<Result<Item>> {
  return transact(
    (items) => addTags(items, id, tags),
    (v) => v.item,
  );
}

export async function removeItemTags(id: string, tags: string[]): Promise<Result<Item>> {
  return transact(
    (items) => removeTags(items, id, tags),
    (v) => v.item,
  );
}

export interface ReprioritizeResult {
  item: Item;
  oldPriority: string;
}

export async function reprioritizeItem(
  id: string,
  priority: "high" | "normal" | "low",
): Promise<Result<ReprioritizeResult>> {
  return transact(
    (items) => reprioritize(items, id, priority),
    (v) => ({ item: v.item, oldPriority: v.oldPriority }),
  );
}

/**
 * Append a phase record to an engineering item. Called mid-flight by the
 * worker after each phase finishes so `hopper show` reflects current progress.
 * Silently no-ops if the item is not found — phase recording is a visibility
 * aid, not a correctness-critical path.
 */
export async function recordItemPhase(id: string, record: PhaseRecord): Promise<void> {
  return transactIfChanged((items) => appendPhase(items, id, record));
}

/**
 * Persist the Haiku-generated branch slug onto an engineering item so that
 * subsequent re-claims always produce the same work-branch name. Best-effort
 * — callers should wrap in try/catch and swallow failures.
 */
export async function setItemEngineeringBranchSlug(id: string, slug: string): Promise<void> {
  return transactIfChanged((items) => setEngineeringBranchSlug(items, id, slug));
}
