import { Status } from "./constants.ts";
import { comparePriority } from "./priority.ts";
import type { ClaimedItem, Item } from "./store.ts";

// ---------------------------------------------------------------------------
// Internal helper
// ---------------------------------------------------------------------------

function replaceItem(items: Item[], id: string, replacement: Item): Item[] {
  return items.map((i) => (i.id === id ? replacement : i));
}

// ---------------------------------------------------------------------------
// claimNext
// ---------------------------------------------------------------------------

export interface ClaimNextResult {
  items: Item[];
  claimed: ClaimedItem | undefined;
}

/**
 * Select and claim the next workable item.
 * Accepts injected `now` and `newUUID` to keep this side-effect-free.
 * Returns a new items array — the input is never mutated.
 */
export function claimNext(
  items: Item[],
  agent: string | undefined,
  now: Date,
  newUUID: string,
): ClaimNextResult {
  const claimable = items
    .filter((i) => {
      if (i.status === Status.QUEUED) return true;
      if (i.status === Status.SCHEDULED && i.scheduledAt && new Date(i.scheduledAt) <= now)
        return true;
      return false;
    })
    .sort((a, b) => {
      const pc = comparePriority(a.priority, b.priority);
      if (pc !== 0) return pc;
      return new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime();
    });

  const next = claimable[0];
  if (!next) return { items, claimed: undefined };

  const claimed: ClaimedItem = {
    ...next,
    status: Status.IN_PROGRESS,
    claimedAt: now.toISOString(),
    claimedBy: agent,
    claimToken: newUUID,
  };
  const updatedItems = replaceItem(items, next.id, claimed);
  return { items: updatedItems, claimed };
}

// ---------------------------------------------------------------------------
// complete
// ---------------------------------------------------------------------------

export interface WorkflowCompleteResult {
  items: Item[];
  completed: Item;
  recurred?: Item;
}

/**
 * Mark an item as completed by claim token.
 * Handles dependency unblocking and recurrence scheduling.
 * Accepts injected `now` and `newUUID` to keep this side-effect-free.
 * Returns a new items array — the input is never mutated.
 */
export function complete(
  items: Item[],
  token: string,
  agent: string | undefined,
  result: string | undefined,
  now: Date,
  newUUID: string,
): WorkflowCompleteResult {
  const item = items.find((i) => i.claimToken === token);

  if (!item) {
    throw new Error(`No in-progress item found with token: ${token}`);
  }
  if (item.status !== Status.IN_PROGRESS) {
    throw new Error(`Item is not in progress (status: ${item.status})`);
  }

  const completedItem: Item = {
    ...item,
    status: Status.COMPLETED,
    completedAt: now.toISOString(),
    completedBy: agent,
    result,
    claimToken: undefined,
  };

  // Replace the completed item and unblock dependents in one pass
  let updatedItems = replaceItem(items, item.id, completedItem);

  updatedItems = updatedItems.map((i) => {
    if (i.status !== Status.BLOCKED) return i;
    const allDepsComplete = (i.dependsOn ?? []).every(
      (depId) => updatedItems.find((x) => x.id === depId)?.status === Status.COMPLETED,
    );
    if (!allDepsComplete) return i;
    return { ...i, status: i.scheduledAt ? Status.SCHEDULED : Status.QUEUED };
  });

  let recurredItem: Item | undefined;
  if (item.recurrence) {
    const nowMs = now.getTime();
    const untilExpired =
      item.recurrence.until && new Date(item.recurrence.until).getTime() <= nowMs;
    const runsExhausted =
      item.recurrence.remainingRuns !== undefined && item.recurrence.remainingRuns <= 0;
    if (!untilExpired && !runsExhausted) {
      const nextRecurrence = { ...item.recurrence };
      if (nextRecurrence.remainingRuns !== undefined) {
        nextRecurrence.remainingRuns = nextRecurrence.remainingRuns - 1;
      }
      recurredItem = {
        id: newUUID,
        title: item.title,
        description: item.description,
        status: Status.SCHEDULED,
        createdAt: now.toISOString(),
        scheduledAt: new Date(nowMs + item.recurrence.intervalMs).toISOString(),
        recurrence: nextRecurrence,
        ...(item.priority ? { priority: item.priority } : {}),
        ...(item.workingDir ? { workingDir: item.workingDir } : {}),
        ...(item.branch ? { branch: item.branch } : {}),
        ...(item.command ? { command: item.command } : {}),
        ...(item.tags?.length ? { tags: [...item.tags] } : {}),
      };
      updatedItems = [recurredItem, ...updatedItems];
    }
  }

  return { items: updatedItems, completed: completedItem, recurred: recurredItem };
}

// ---------------------------------------------------------------------------
// requeue
// ---------------------------------------------------------------------------

export interface RequeueResult {
  items: Item[];
  requeued: Item;
}

/**
 * Reset an in-progress item back to queued.
 * Clears claim fields and records the requeue reason and agent.
 * Returns a new items array — the input is never mutated.
 */
export function requeue(
  items: Item[],
  id: string,
  reason: string,
  agent: string | undefined,
): RequeueResult {
  const item = resolveItem(items, id);
  if (item.status !== Status.IN_PROGRESS) {
    throw new Error(`Item is not in progress (status: ${item.status})`);
  }

  const requeued: Item = {
    ...item,
    status: Status.QUEUED,
    claimedAt: undefined,
    claimedBy: undefined,
    claimToken: undefined,
    requeueReason: reason,
    requeuedBy: agent,
  };
  const updatedItems = replaceItem(items, item.id, requeued);
  return { items: updatedItems, requeued };
}

// ---------------------------------------------------------------------------
// cancel
// ---------------------------------------------------------------------------

export interface CancelWorkflowResult {
  items: Item[];
  cancelled: Item;
  blockedDependentCount: number;
}

/**
 * Cancel a queued, scheduled, or blocked item.
 * Counts how many blocked items depended on the cancelled item.
 * Returns a new items array — the input is never mutated.
 */
export function cancel(items: Item[], id: string, now: Date): CancelWorkflowResult {
  const item = resolveItem(items, id);
  if (
    item.status !== Status.QUEUED &&
    item.status !== Status.SCHEDULED &&
    item.status !== Status.BLOCKED
  ) {
    throw new Error(
      `Cannot cancel item — status is "${item.status}". Only queued, scheduled, or blocked items can be cancelled.`,
    );
  }

  const cancelled: Item = {
    ...item,
    status: Status.CANCELLED,
    cancelledAt: now.toISOString(),
  };
  const updatedItems = replaceItem(items, item.id, cancelled);

  const blockedDependentCount = items.filter(
    (i) => i.status === Status.BLOCKED && (i.dependsOn ?? []).includes(item.id),
  ).length;

  return { items: updatedItems, cancelled, blockedDependentCount };
}

// ---------------------------------------------------------------------------
// reprioritize
// ---------------------------------------------------------------------------

export interface ReprioritizeWorkflowResult {
  items: Item[];
  item: Item;
  oldPriority: string;
}

/**
 * Change priority of a queued or scheduled item.
 * Returns a new items array — the input is never mutated.
 */
export function reprioritize(
  items: Item[],
  id: string,
  priority: "high" | "normal" | "low",
): ReprioritizeWorkflowResult {
  const item = resolveItem(items, id);
  if (item.status !== Status.QUEUED && item.status !== Status.SCHEDULED) {
    throw new Error(
      `Cannot reprioritize item — status is "${item.status}". Only queued or scheduled items can be reprioritized.`,
    );
  }

  const oldPriority = item.priority ?? "normal";
  const updated: Item = { ...item, priority };
  const updatedItems = replaceItem(items, item.id, updated);
  return { items: updatedItems, item: updated, oldPriority };
}

// ---------------------------------------------------------------------------
// addTags / removeTags
// ---------------------------------------------------------------------------

export interface TagResult {
  items: Item[];
  item: Item;
}

/**
 * Merge tags into an item (deduplicates and sorts).
 * Returns a new items array — the input is never mutated.
 */
export function addTags(items: Item[], id: string, tags: string[]): TagResult {
  const item = resolveItem(items, id);
  const merged = [...new Set([...(item.tags ?? []), ...tags])].sort();
  const updated: Item = { ...item, tags: merged };
  const updatedItems = replaceItem(items, item.id, updated);
  return { items: updatedItems, item: updated };
}

/**
 * Remove specific tags from an item.
 * Clears the tags field entirely if no tags remain.
 * Returns a new items array — the input is never mutated.
 */
export function removeTags(items: Item[], id: string, tags: string[]): TagResult {
  const item = resolveItem(items, id);
  const tagSet = new Set(tags);
  const remaining = (item.tags ?? []).filter((t) => !tagSet.has(t));
  const updated: Item = { ...item, tags: remaining.length > 0 ? remaining : undefined };
  const updatedItems = replaceItem(items, item.id, updated);
  return { items: updatedItems, item: updated };
}

// ---------------------------------------------------------------------------
// prependItem
// ---------------------------------------------------------------------------

/**
 * Return a new array with `item` prepended.
 */
export function prependItem(items: Item[], item: Item): Item[] {
  return [item, ...items];
}

// ---------------------------------------------------------------------------
// resolveItem
// ---------------------------------------------------------------------------

/**
 * Resolve an item by exact ID or unique ID prefix.
 * Throws if no match is found or if the prefix is ambiguous.
 */
export function resolveItem(items: Item[], id: string): Item {
  const matches = items.filter((i) => i.id === id || i.id.startsWith(id));

  if (matches.length === 0) {
    throw new Error(`No item found with id: ${id}`);
  }
  if (matches.length > 1) {
    throw new Error(
      `Ambiguous id prefix "${id}" matches ${matches.length} items. Use a longer prefix.`,
    );
  }

  return matches[0] as Item;
}
