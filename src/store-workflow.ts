import { Status } from "./constants.ts";
import { comparePriority } from "./priority.ts";
import { err, ok, type Result } from "./result.ts";
import type { ClaimedItem, Item, PhaseRecord } from "./store.ts";

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function replaceItem(items: Item[], id: string, replacement: Item): Item[] {
  return items.map((i) => (i.id === id ? replacement : i));
}

// ---------------------------------------------------------------------------
// Directory overlap detection
// ---------------------------------------------------------------------------

/**
 * Strip trailing slashes from a directory path for consistent comparison.
 */
export function normalizeDir(dir: string): string {
  return dir.replace(/\/+$/, "");
}

/**
 * Check whether two directory paths overlap — meaning they are the same
 * directory, or one is an ancestor of the other.
 *
 * Uses a `/` boundary to avoid false positives:
 *   dirsOverlap("/a/b", "/a/bc") → false
 *   dirsOverlap("/a/b", "/a/b/c") → true
 *   dirsOverlap("/a/b", "/a/b")   → true
 */
export function dirsOverlap(a: string, b: string): boolean {
  const normA = normalizeDir(a);
  const normB = normalizeDir(b);
  if (normA === normB) return true;
  return normA.startsWith(`${normB}/`) || normB.startsWith(`${normA}/`);
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
 *
 * Directory-aware: items whose effective working directory overlaps with
 * an already in-progress item's directory are skipped. This prevents
 * concurrent work in the same (or nested) project directories.
 *
 * @param cwd  Effective CWD for items without an explicit workingDir.
 *             When omitted, no-dir items are treated as ungrouped.
 *
 * Returns a new items array — the input is never mutated.
 */
export function claimNext(
  items: Item[],
  agent: string | undefined,
  now: Date,
  newUUID: string,
  cwd?: string,
): ClaimNextResult {
  // Compute busy directories from in-progress items
  const busyDirs = items
    .filter((i) => i.status === Status.IN_PROGRESS)
    .map((i) => i.workingDir ?? cwd)
    .filter((d): d is string => d !== undefined);

  const claimable = items
    .filter((i) => {
      if (i.status === Status.QUEUED) {
        // ok
      } else if (i.status === Status.SCHEDULED && i.scheduledAt && new Date(i.scheduledAt) <= now) {
        // ok
      } else {
        return false;
      }

      // Skip if this item's effective dir overlaps with any busy dir
      const effectiveDir = i.workingDir ?? cwd;
      if (effectiveDir && busyDirs.some((busy) => dirsOverlap(effectiveDir, busy))) {
        return false;
      }
      return true;
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
): Result<WorkflowCompleteResult> {
  const item = items.find((i) => i.claimToken === token);

  if (!item) {
    return err(`No in-progress item found with token: ${token}`);
  }
  if (item.status !== Status.IN_PROGRESS) {
    return err(`Item is not in progress (status: ${item.status})`);
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
        ...(item.type ? { type: item.type } : {}),
        ...(item.agent ? { agent: item.agent } : {}),
        ...(item.retries !== undefined ? { retries: item.retries } : {}),
      };
      updatedItems = [recurredItem, ...updatedItems];
    }
  }

  return ok({ items: updatedItems, completed: completedItem, recurred: recurredItem });
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
): Result<RequeueResult> {
  const itemResult = resolveItem(items, id);
  if (!itemResult.ok) return itemResult;
  const item = itemResult.value;
  if (item.status !== Status.IN_PROGRESS) {
    return err(`Item is not in progress (status: ${item.status})`);
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
  return ok({ items: updatedItems, requeued });
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
export function cancel(items: Item[], id: string, now: Date): Result<CancelWorkflowResult> {
  const itemResult = resolveItem(items, id);
  if (!itemResult.ok) return itemResult;
  const item = itemResult.value;
  if (
    item.status !== Status.QUEUED &&
    item.status !== Status.SCHEDULED &&
    item.status !== Status.BLOCKED
  ) {
    return err(
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

  return ok({ items: updatedItems, cancelled, blockedDependentCount });
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
): Result<ReprioritizeWorkflowResult> {
  const itemResult = resolveItem(items, id);
  if (!itemResult.ok) return itemResult;
  const item = itemResult.value;
  if (item.status !== Status.QUEUED && item.status !== Status.SCHEDULED) {
    return err(
      `Cannot reprioritize item — status is "${item.status}". Only queued or scheduled items can be reprioritized.`,
    );
  }

  const oldPriority = item.priority ?? "normal";
  const updated: Item = { ...item, priority };
  const updatedItems = replaceItem(items, item.id, updated);
  return ok({ items: updatedItems, item: updated, oldPriority });
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
export function addTags(items: Item[], id: string, tags: string[]): Result<TagResult> {
  const itemResult = resolveItem(items, id);
  if (!itemResult.ok) return itemResult;
  const item = itemResult.value;
  const merged = [...new Set([...(item.tags ?? []), ...tags])].sort();
  const updated: Item = { ...item, tags: merged };
  const updatedItems = replaceItem(items, item.id, updated);
  return ok({ items: updatedItems, item: updated });
}

/**
 * Remove specific tags from an item.
 * Clears the tags field entirely if no tags remain.
 * Returns a new items array — the input is never mutated.
 */
export function removeTags(items: Item[], id: string, tags: string[]): Result<TagResult> {
  const itemResult = resolveItem(items, id);
  if (!itemResult.ok) return itemResult;
  const item = itemResult.value;
  const tagSet = new Set(tags);
  const remaining = (item.tags ?? []).filter((t) => !tagSet.has(t));
  const updated: Item = { ...item, tags: remaining.length > 0 ? remaining : undefined };
  const updatedItems = replaceItem(items, item.id, updated);
  return ok({ items: updatedItems, item: updated });
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
// appendPhase
// ---------------------------------------------------------------------------

export interface AppendPhaseResult {
  items: Item[];
  changed: boolean;
}

/**
 * Append a phase record to an engineering item's `phases` array.
 *
 * Returns `changed: false` when the item is not found — phase recording is a
 * visibility aid and must never be allowed to crash the worker on a stale id.
 * Duplicates are keyed on `{name, attempt}` (attempt defaults to 1 when
 * missing) so remediation retries — which re-run execute/validate at
 * attempt=2, 3, … — keep stacking, while an accidental double-write of the
 * same attempt just replaces.
 */
export function appendPhase(items: Item[], itemId: string, record: PhaseRecord): AppendPhaseResult {
  const target = items.find((i) => i.id === itemId);
  if (!target) return { items, changed: false };

  const attemptOf = (p: PhaseRecord): number => p.attempt ?? 1;
  const recordAttempt = attemptOf(record);

  const existing = target.phases ?? [];
  const withoutDup = existing.filter(
    (p) => !(p.name === record.name && attemptOf(p) === recordAttempt),
  );
  const nextPhases = [...withoutDup, record];

  const updated: Item = { ...target, phases: nextPhases };
  return { items: replaceItem(items, itemId, updated), changed: true };
}

// ---------------------------------------------------------------------------
// ensureDefaults
// ---------------------------------------------------------------------------

/**
 * Apply default field values to a raw JSON record loaded from storage.
 * Handles legacy items that were saved without a status field.
 */
export function ensureDefaults(raw: Record<string, unknown>): Item {
  if (!raw.status) {
    raw.status = Status.QUEUED;
  }
  return raw as unknown as Item;
}

// ---------------------------------------------------------------------------
// resolveItem
// ---------------------------------------------------------------------------

/**
 * Resolve an item by exact ID or unique ID prefix.
 * Returns error result if no match is found or if the prefix is ambiguous.
 */
export function resolveItem(items: Item[], id: string): Result<Item> {
  const matches = items.filter((i) => i.id === id || i.id.startsWith(id));

  if (matches.length === 0) {
    return err(`No item found with id: ${id}`);
  }
  if (matches.length > 1) {
    return err(
      `Ambiguous id prefix "${id}" matches ${matches.length} items. Use a longer prefix.`,
    );
  }

  return ok(matches[0] as Item);
}
