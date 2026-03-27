import { Status } from "./constants.ts";
import { comparePriority } from "./priority.ts";
import type { ClaimedItem, Item } from "./store.ts";

// ---------------------------------------------------------------------------
// claimNext
// ---------------------------------------------------------------------------

export interface ClaimNextResult {
  items: Item[];
  claimed: ClaimedItem | undefined;
}

/**
 * Pure function: select and claim the next workable item.
 * Accepts injected `now` and `newUUID` to keep this side-effect-free.
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

  next.status = Status.IN_PROGRESS;
  next.claimedAt = now.toISOString();
  next.claimedBy = agent;
  next.claimToken = newUUID;

  return { items, claimed: next as ClaimedItem };
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
 * Pure function: mark an item as completed by claim token.
 * Handles dependency unblocking and recurrence scheduling.
 * Accepts injected `now` and `newUUID` to keep this side-effect-free.
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

  item.status = Status.COMPLETED;
  item.completedAt = now.toISOString();
  item.completedBy = agent;
  item.result = result;
  item.claimToken = undefined;

  // Unblock items that depended on this completed item
  for (const blocked of items.filter((i) => i.status === Status.BLOCKED)) {
    const allDepsComplete = (blocked.dependsOn ?? []).every(
      (depId) => items.find((i) => i.id === depId)?.status === Status.COMPLETED,
    );
    if (allDepsComplete) {
      blocked.status = blocked.scheduledAt ? Status.SCHEDULED : Status.QUEUED;
    }
  }

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
      items.unshift(recurredItem);
    }
  }

  return { items, completed: item, recurred: recurredItem };
}

// ---------------------------------------------------------------------------
// requeue
// ---------------------------------------------------------------------------

export interface RequeueResult {
  items: Item[];
  requeued: Item;
}

/**
 * Pure function: reset an in-progress item back to queued.
 * Clears claim fields and records the requeue reason and agent.
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

  item.status = Status.QUEUED;
  item.claimedAt = undefined;
  item.claimedBy = undefined;
  item.claimToken = undefined;
  item.requeueReason = reason;
  item.requeuedBy = agent;

  return { items, requeued: item };
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
 * Pure function: cancel a queued, scheduled, or blocked item.
 * Counts how many blocked items depended on the cancelled item.
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

  item.status = Status.CANCELLED;
  item.cancelledAt = now.toISOString();

  const blockedDependentCount = items.filter(
    (i) => i.status === Status.BLOCKED && (i.dependsOn ?? []).includes(item.id),
  ).length;

  return { items, cancelled: item, blockedDependentCount };
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
 * Pure function: change priority of a queued or scheduled item.
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
  item.priority = priority;

  return { items, item, oldPriority };
}

// ---------------------------------------------------------------------------
// addTags / removeTags
// ---------------------------------------------------------------------------

export interface TagResult {
  items: Item[];
  item: Item;
}

/**
 * Pure function: merge tags into an item (deduplicates and sorts).
 */
export function addTags(items: Item[], id: string, tags: string[]): TagResult {
  const item = resolveItem(items, id);
  const merged = [...new Set([...(item.tags ?? []), ...tags])].sort();
  item.tags = merged;
  return { items, item };
}

/**
 * Pure function: remove specific tags from an item.
 * Clears the tags field entirely if no tags remain.
 */
export function removeTags(items: Item[], id: string, tags: string[]): TagResult {
  const item = resolveItem(items, id);
  const tagSet = new Set(tags);
  item.tags = (item.tags ?? []).filter((t) => !tagSet.has(t));
  if (item.tags.length === 0) item.tags = undefined;
  return { items, item };
}

// ---------------------------------------------------------------------------
// prependItem
// ---------------------------------------------------------------------------

/**
 * Pure function: return a new array with `item` prepended.
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
