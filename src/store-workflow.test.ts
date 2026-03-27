import { describe, expect, test } from "bun:test";
import type { Item } from "./store.ts";
import {
  addTags,
  cancel,
  claimNext,
  complete,
  prependItem,
  removeTags,
  reprioritize,
  requeue,
} from "./store-workflow.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let idCounter = 0;

function makeItem(overrides?: Partial<Item>): Item {
  idCounter += 1;
  return {
    id: `00000000-0000-0000-0000-${String(idCounter).padStart(12, "0")}`,
    title: "Test item",
    description: "A test description",
    status: "queued",
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

const FIXED_NOW = new Date("2025-06-01T12:00:00.000Z");
const FIXED_UUID = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";

// ---------------------------------------------------------------------------
// claimNext
// ---------------------------------------------------------------------------

describe("claimNext", () => {
  test("returns undefined claimed when queue is empty", () => {
    const result = claimNext([], undefined, FIXED_NOW, FIXED_UUID);
    expect(result.claimed).toBeUndefined();
  });

  test("returns undefined claimed when all items are in_progress", () => {
    const items = [makeItem({ status: "in_progress", claimedAt: FIXED_NOW.toISOString() })];
    const result = claimNext(items, undefined, FIXED_NOW, FIXED_UUID);
    expect(result.claimed).toBeUndefined();
  });

  test("claims the only queued item", () => {
    const item = makeItem({ status: "queued" });
    const result = claimNext([item], "agent", FIXED_NOW, FIXED_UUID);

    expect(result.claimed).toBeDefined();
    expect(result.claimed?.id).toBe(item.id);
    expect(result.claimed?.status).toBe("in_progress");
    expect(result.claimed?.claimedBy).toBe("agent");
    expect(result.claimed?.claimToken).toBe(FIXED_UUID);
    expect(result.claimed?.claimedAt).toBe(FIXED_NOW.toISOString());
  });

  test("claims oldest queued item (FIFO within same priority)", () => {
    const older = makeItem({ title: "Older", createdAt: "2025-01-01T00:00:00Z" });
    const newer = makeItem({ title: "Newer", createdAt: "2025-06-01T00:00:00Z" });
    const result = claimNext([newer, older], "agent", FIXED_NOW, FIXED_UUID);

    expect(result.claimed?.title).toBe("Older");
  });

  test("skips in_progress items", () => {
    const inProgress = makeItem({
      title: "In Progress",
      status: "in_progress",
      createdAt: "2025-01-01T00:00:00Z",
    });
    const queued = makeItem({
      title: "Queued",
      status: "queued",
      createdAt: "2025-06-01T00:00:00Z",
    });
    const result = claimNext([inProgress, queued], undefined, FIXED_NOW, FIXED_UUID);

    expect(result.claimed?.title).toBe("Queued");
  });

  test("includes scheduled items that are past due", () => {
    const pastDate = new Date(FIXED_NOW.getTime() - 1000).toISOString();
    const scheduled = makeItem({
      title: "Due scheduled",
      status: "scheduled",
      scheduledAt: pastDate,
      createdAt: "2025-01-01T00:00:00Z",
    });
    const result = claimNext([scheduled], undefined, FIXED_NOW, FIXED_UUID);

    expect(result.claimed?.title).toBe("Due scheduled");
    expect(result.claimed?.status).toBe("in_progress");
  });

  test("excludes future-scheduled items", () => {
    const futureDate = new Date(FIXED_NOW.getTime() + 3_600_000).toISOString();
    const scheduled = makeItem({
      title: "Future scheduled",
      status: "scheduled",
      scheduledAt: futureDate,
      createdAt: "2025-01-01T00:00:00Z",
    });
    const result = claimNext([scheduled], undefined, FIXED_NOW, FIXED_UUID);

    expect(result.claimed).toBeUndefined();
  });

  test("high priority beats normal priority", () => {
    const normal = makeItem({ title: "Normal", createdAt: "2025-01-01T00:00:00Z" });
    const high = makeItem({
      title: "High",
      priority: "high",
      createdAt: "2025-06-01T00:00:00Z",
    });
    const result = claimNext([normal, high], undefined, FIXED_NOW, FIXED_UUID);

    expect(result.claimed?.title).toBe("High");
  });

  test("normal priority beats low priority", () => {
    const low = makeItem({
      title: "Low",
      priority: "low",
      createdAt: "2025-01-01T00:00:00Z",
    });
    const normal = makeItem({ title: "Normal", createdAt: "2025-06-01T00:00:00Z" });
    const result = claimNext([low, normal], undefined, FIXED_NOW, FIXED_UUID);

    expect(result.claimed?.title).toBe("Normal");
  });

  test("items without priority field treated as normal", () => {
    const noPriority = makeItem({ title: "No priority", createdAt: "2025-01-01T00:00:00Z" });
    const high = makeItem({
      title: "High",
      priority: "high",
      createdAt: "2025-06-01T00:00:00Z",
    });
    const result = claimNext([noPriority, high], undefined, FIXED_NOW, FIXED_UUID);

    expect(result.claimed?.title).toBe("High");
  });

  test("uses injected now for claimedAt timestamp", () => {
    const item = makeItem();
    const result = claimNext([item], "agent", FIXED_NOW, FIXED_UUID);

    expect(result.claimed?.claimedAt).toBe(FIXED_NOW.toISOString());
  });

  test("uses injected newUUID for claimToken", () => {
    const item = makeItem();
    const result = claimNext([item], "agent", FIXED_NOW, FIXED_UUID);

    expect(result.claimed?.claimToken).toBe(FIXED_UUID);
  });

  test("returns new items array with claimed item updated (does not mutate input)", () => {
    const item = makeItem();
    const items = [item];
    const result = claimNext(items, "agent", FIXED_NOW, FIXED_UUID);

    // Original item is unchanged
    expect(item.status).toBe("queued");
    // Returned items array is a new reference
    expect(result.items).not.toBe(items);
    // Returned items array has the updated item
    expect(result.items[0]?.status).toBe("in_progress");
  });

  test("does not mutate items array when nothing to claim", () => {
    const inProgress = makeItem({ status: "in_progress" });
    const items = [inProgress];
    const result = claimNext(items, "agent", FIXED_NOW, FIXED_UUID);

    expect(result.claimed).toBeUndefined();
    expect(result.items).toBe(items);
  });

  test("does not mutate the original items or their properties", () => {
    const item = makeItem({ status: "queued" });
    const items = [item];
    const originalStatus = item.status;
    claimNext(items, "agent", FIXED_NOW, FIXED_UUID);

    expect(item.status).toBe(originalStatus);
    expect(items).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// complete
// ---------------------------------------------------------------------------

describe("complete", () => {
  function makeInProgressItem(overrides?: Partial<Item>): Item {
    return makeItem({
      status: "in_progress",
      claimedAt: FIXED_NOW.toISOString(),
      claimedBy: "agent",
      claimToken: FIXED_UUID,
      ...overrides,
    });
  }

  test("marks item as completed with valid token", () => {
    const item = makeInProgressItem();
    const result = complete([item], FIXED_UUID, "agent", undefined, FIXED_NOW, "new-uuid");

    expect(result.completed.status).toBe("completed");
    expect(result.completed.completedAt).toBe(FIXED_NOW.toISOString());
    expect(result.completed.completedBy).toBe("agent");
  });

  test("throws on invalid token", () => {
    const item = makeInProgressItem();
    expect(() => complete([item], "bad-token", "agent", undefined, FIXED_NOW, "new-uuid")).toThrow(
      "No in-progress item found",
    );
  });

  test("throws when item is not in_progress", () => {
    const item = makeItem({ status: "queued", claimToken: FIXED_UUID });
    expect(() => complete([item], FIXED_UUID, "agent", undefined, FIXED_NOW, "new-uuid")).toThrow(
      "not in progress",
    );
  });

  test("stores result when provided", () => {
    const item = makeInProgressItem();
    const result = complete([item], FIXED_UUID, "agent", "Fixed the bug", FIXED_NOW, "new-uuid");

    expect(result.completed.result).toBe("Fixed the bug");
  });

  test("result is undefined when not provided", () => {
    const item = makeInProgressItem();
    const result = complete([item], FIXED_UUID, "agent", undefined, FIXED_NOW, "new-uuid");

    expect(result.completed.result).toBeUndefined();
  });

  test("clears claim token after completion", () => {
    const item = makeInProgressItem();
    const result = complete([item], FIXED_UUID, "agent", undefined, FIXED_NOW, "new-uuid");

    expect(result.completed.claimToken).toBeUndefined();
  });

  test("unblocks single-dependency blocked item to queued", () => {
    const dep = makeInProgressItem({ id: "dep-id-0000-0000-0000-000000000001" });
    const blocked = makeItem({
      id: "blocked-id-0000-0000-0000-000000000001",
      status: "blocked",
      dependsOn: [dep.id],
    });
    const result = complete([dep, blocked], FIXED_UUID, "agent", undefined, FIXED_NOW, "new-uuid");

    const updatedBlocked = result.items.find((i) => i.id === blocked.id);
    expect(updatedBlocked?.status).toBe("queued");
  });

  test("unblocks blocked item with scheduledAt to scheduled", () => {
    const dep = makeInProgressItem({ id: "dep-id-0000-0000-0000-000000000002" });
    const futureDate = new Date(FIXED_NOW.getTime() + 3_600_000).toISOString();
    const blocked = makeItem({
      id: "blocked-id-0000-0000-0000-000000000002",
      status: "blocked",
      dependsOn: [dep.id],
      scheduledAt: futureDate,
    });
    const result = complete([dep, blocked], FIXED_UUID, "agent", undefined, FIXED_NOW, "new-uuid");

    const updatedBlocked = result.items.find((i) => i.id === blocked.id);
    expect(updatedBlocked?.status).toBe("scheduled");
  });

  test("multi-dependency: stays blocked until all deps complete", () => {
    const dep1 = makeInProgressItem({ id: "dep1-id-0000-0000-0000-000000000001" });
    const dep2 = makeItem({
      id: "dep2-id-0000-0000-0000-000000000001",
      status: "queued",
    });
    const blocked = makeItem({
      id: "blocked-multi-0000-0000-0000-000000000001",
      status: "blocked",
      dependsOn: [dep1.id, dep2.id],
    });
    const result = complete(
      [dep1, dep2, blocked],
      FIXED_UUID,
      "agent",
      undefined,
      FIXED_NOW,
      "new-uuid",
    );

    const updatedBlocked = result.items.find((i) => i.id === blocked.id);
    expect(updatedBlocked?.status).toBe("blocked");
  });

  test("recurrence creates new scheduled item with decremented remainingRuns", () => {
    const item = makeInProgressItem({
      title: "Recurring",
      recurrence: { interval: "4h", intervalMs: 4 * 3_600_000, remainingRuns: 2 },
    });
    const result = complete([item], FIXED_UUID, "agent", undefined, FIXED_NOW, "recurred-uuid");

    expect(result.recurred).toBeDefined();
    expect(result.recurred?.status).toBe("scheduled");
    expect(result.recurred?.recurrence?.remainingRuns).toBe(1);
    expect(result.recurred?.id).toBe("recurred-uuid");
  });

  test("recurrence stops when remainingRuns is 0", () => {
    const item = makeInProgressItem({
      recurrence: { interval: "1h", intervalMs: 3_600_000, remainingRuns: 0 },
    });
    const result = complete([item], FIXED_UUID, "agent", undefined, FIXED_NOW, "recurred-uuid");

    expect(result.recurred).toBeUndefined();
  });

  test("recurrence stops when until has passed", () => {
    const expiredUntil = new Date(FIXED_NOW.getTime() - 1000).toISOString();
    const item = makeInProgressItem({
      recurrence: { interval: "1h", intervalMs: 3_600_000, until: expiredUntil },
    });
    const result = complete([item], FIXED_UUID, "agent", undefined, FIXED_NOW, "recurred-uuid");

    expect(result.recurred).toBeUndefined();
  });

  test("recurrence continues when remainingRuns is not set", () => {
    const item = makeInProgressItem({
      recurrence: { interval: "1h", intervalMs: 3_600_000 },
    });
    const result = complete([item], FIXED_UUID, "agent", undefined, FIXED_NOW, "recurred-uuid");

    expect(result.recurred).toBeDefined();
    expect(result.recurred?.recurrence?.remainingRuns).toBeUndefined();
  });

  test("recurred item preserves workingDir, branch, priority, command, tags", () => {
    const item = makeInProgressItem({
      title: "Full item",
      workingDir: "/tmp/project",
      branch: "main",
      priority: "high",
      command: "make test",
      tags: ["tag1", "tag2"],
      recurrence: { interval: "1h", intervalMs: 3_600_000 },
    });
    const result = complete([item], FIXED_UUID, "agent", undefined, FIXED_NOW, "recurred-uuid");

    expect(result.recurred?.workingDir).toBe("/tmp/project");
    expect(result.recurred?.branch).toBe("main");
    expect(result.recurred?.priority).toBe("high");
    expect(result.recurred?.command).toBe("make test");
    expect(result.recurred?.tags).toEqual(["tag1", "tag2"]);
  });

  test("recurred item has scheduledAt = now + intervalMs", () => {
    const item = makeInProgressItem({
      recurrence: { interval: "4h", intervalMs: 4 * 3_600_000 },
    });
    const result = complete([item], FIXED_UUID, "agent", undefined, FIXED_NOW, "recurred-uuid");

    const expectedScheduledAt = new Date(FIXED_NOW.getTime() + 4 * 3_600_000).toISOString();
    expect(result.recurred?.scheduledAt).toBe(expectedScheduledAt);
  });

  test("recurred item is prepended to the items array", () => {
    const item = makeInProgressItem({
      recurrence: { interval: "1h", intervalMs: 3_600_000 },
    });
    const result = complete([item], FIXED_UUID, "agent", undefined, FIXED_NOW, "recurred-uuid");

    expect(result.items[0]?.id).toBe("recurred-uuid");
    expect(result.items).toHaveLength(2);
  });

  test("does not mutate the original item or items array", () => {
    const item = makeInProgressItem();
    const items = [item];
    const originalStatus = item.status;
    complete(items, FIXED_UUID, "agent", undefined, FIXED_NOW, "new-uuid");

    expect(item.status).toBe(originalStatus);
    expect(items).toHaveLength(1);
  });

  test("returns new items array reference", () => {
    const item = makeInProgressItem();
    const items = [item];
    const result = complete(items, FIXED_UUID, "agent", undefined, FIXED_NOW, "new-uuid");

    expect(result.items).not.toBe(items);
    expect(result.items[0]?.status).toBe("completed");
  });
});

// ---------------------------------------------------------------------------
// requeue
// ---------------------------------------------------------------------------

describe("requeue", () => {
  test("resets in_progress item to queued with reason", () => {
    const item = makeItem({
      status: "in_progress",
      claimedAt: FIXED_NOW.toISOString(),
      claimedBy: "agent",
      claimToken: FIXED_UUID,
    });
    const result = requeue([item], item.id, "needs more info", "agent");

    expect(result.requeued.status).toBe("queued");
    expect(result.requeued.requeueReason).toBe("needs more info");
    expect(result.requeued.requeuedBy).toBe("agent");
  });

  test("clears claim fields after requeue", () => {
    const item = makeItem({
      status: "in_progress",
      claimedAt: FIXED_NOW.toISOString(),
      claimedBy: "agent",
      claimToken: FIXED_UUID,
    });
    const result = requeue([item], item.id, "blocked", "agent");

    expect(result.requeued.claimedAt).toBeUndefined();
    expect(result.requeued.claimedBy).toBeUndefined();
    expect(result.requeued.claimToken).toBeUndefined();
  });

  test("rejects non-in_progress items", () => {
    const item = makeItem({ status: "queued" });
    expect(() => requeue([item], item.id, "reason", undefined)).toThrow("not in progress");
  });

  test("throws on no match", () => {
    const item = makeItem();
    expect(() => requeue([item], "nonexistent", "reason", undefined)).toThrow("No item found");
  });

  test("throws on ambiguous prefix", () => {
    const a = makeItem({ id: "abcd0000-0000-0000-0000-000000000000", status: "in_progress" });
    const b = makeItem({ id: "abcd1111-0000-0000-0000-000000000000", status: "in_progress" });
    expect(() => requeue([a, b], "abcd", "reason", undefined)).toThrow("Ambiguous id prefix");
  });

  test("preserves createdAt", () => {
    const originalCreatedAt = "2025-01-01T00:00:00Z";
    const item = makeItem({
      createdAt: originalCreatedAt,
      status: "in_progress",
      claimToken: FIXED_UUID,
    });
    const result = requeue([item], item.id, "reason", undefined);

    expect(result.requeued.createdAt).toBe(originalCreatedAt);
  });

  test("returns new items array (does not mutate input)", () => {
    const item = makeItem({ status: "in_progress", claimToken: FIXED_UUID });
    const items = [item];
    const result = requeue(items, item.id, "reason", undefined);

    expect(result.items).not.toBe(items);
    expect(result.items[0]?.status).toBe("queued");
  });

  test("does not mutate the original item or items array", () => {
    const item = makeItem({ status: "in_progress", claimToken: FIXED_UUID });
    const items = [item];
    requeue(items, item.id, "reason", undefined);

    expect(item.status).toBe("in_progress");
    expect(items).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// cancel
// ---------------------------------------------------------------------------

describe("cancel", () => {
  test("cancels a queued item", () => {
    const item = makeItem({ title: "To cancel", status: "queued" });
    const result = cancel([item], item.id, FIXED_NOW);

    expect(result.cancelled.status).toBe("cancelled");
    expect(result.cancelled.cancelledAt).toBe(FIXED_NOW.toISOString());
    expect(result.cancelled.title).toBe("To cancel");
  });

  test("cancels a scheduled item", () => {
    const futureDate = new Date(FIXED_NOW.getTime() + 3_600_000).toISOString();
    const item = makeItem({ status: "scheduled", scheduledAt: futureDate });
    const result = cancel([item], item.id, FIXED_NOW);

    expect(result.cancelled.status).toBe("cancelled");
  });

  test("cancels a blocked item", () => {
    const dep = makeItem({ id: "dep-id-cancel-0000-0000-0000-000000000001" });
    const blocked = makeItem({
      status: "blocked",
      dependsOn: [dep.id],
    });
    const result = cancel([dep, blocked], blocked.id, FIXED_NOW);

    expect(result.cancelled.status).toBe("cancelled");
  });

  test("rejects in_progress items", () => {
    const item = makeItem({ status: "in_progress", claimedAt: FIXED_NOW.toISOString() });
    expect(() => cancel([item], item.id, FIXED_NOW)).toThrow("Cannot cancel item");
  });

  test("rejects completed items", () => {
    const item = makeItem({ status: "completed", completedAt: FIXED_NOW.toISOString() });
    expect(() => cancel([item], item.id, FIXED_NOW)).toThrow(
      "Only queued, scheduled, or blocked items can be cancelled",
    );
  });

  test("returns correct blocked dependent count", () => {
    const dep = makeItem({ id: "dep-id-cancel-count-0000-0000-000000000001" });
    const blocked1 = makeItem({
      status: "blocked",
      dependsOn: [dep.id],
    });
    const blocked2 = makeItem({
      status: "blocked",
      dependsOn: [dep.id],
    });
    const result = cancel([dep, blocked1, blocked2], dep.id, FIXED_NOW);

    expect(result.blockedDependentCount).toBe(2);
  });

  test("returns 0 blocked dependent count when none", () => {
    const item = makeItem({ status: "queued" });
    const result = cancel([item], item.id, FIXED_NOW);

    expect(result.blockedDependentCount).toBe(0);
  });

  test("prefix matching works", () => {
    const item = makeItem({ id: "abcd1234-cancel-0000-0000-000000000000", title: "Cancel me" });
    const result = cancel([item], "abcd1234", FIXED_NOW);

    expect(result.cancelled.title).toBe("Cancel me");
    expect(result.cancelled.status).toBe("cancelled");
  });

  test("throws on no match", () => {
    const item = makeItem();
    expect(() => cancel([item], "nonexistent", FIXED_NOW)).toThrow("No item found");
  });

  test("throws on ambiguous prefix", () => {
    const a = makeItem({ id: "abcd0000-cancel-0000-0000-000000000000" });
    const b = makeItem({ id: "abcd1111-cancel-0000-0000-000000000000" });
    expect(() => cancel([a, b], "abcd", FIXED_NOW)).toThrow("Ambiguous id prefix");
  });

  test("does not mutate the original item or items array", () => {
    const item = makeItem({ status: "queued" });
    const items = [item];
    cancel(items, item.id, FIXED_NOW);

    expect(item.status).toBe("queued");
    expect(items).toHaveLength(1);
  });

  test("returns new items array reference", () => {
    const item = makeItem({ status: "queued" });
    const items = [item];
    const result = cancel(items, item.id, FIXED_NOW);

    expect(result.items).not.toBe(items);
    expect(result.items[0]?.status).toBe("cancelled");
  });
});

// ---------------------------------------------------------------------------
// reprioritize
// ---------------------------------------------------------------------------

describe("reprioritize", () => {
  test("changes priority on a queued item", () => {
    const item = makeItem({ status: "queued" });
    const result = reprioritize([item], item.id, "high");

    expect(result.item.priority).toBe("high");
    expect(result.oldPriority).toBe("normal");
  });

  test("changes priority on a scheduled item", () => {
    const item = makeItem({
      status: "scheduled",
      scheduledAt: new Date(FIXED_NOW.getTime() + 3_600_000).toISOString(),
    });
    const result = reprioritize([item], item.id, "low");

    expect(result.item.priority).toBe("low");
  });

  test("returns correct oldPriority when item had explicit priority", () => {
    const item = makeItem({ status: "queued", priority: "high" });
    const result = reprioritize([item], item.id, "low");

    expect(result.oldPriority).toBe("high");
  });

  test("oldPriority defaults to normal when item had no priority set", () => {
    const item = makeItem({ status: "queued" });
    const result = reprioritize([item], item.id, "low");

    expect(result.oldPriority).toBe("normal");
  });

  test("rejects in_progress items", () => {
    const item = makeItem({ status: "in_progress", claimedAt: FIXED_NOW.toISOString() });
    expect(() => reprioritize([item], item.id, "high")).toThrow("Cannot reprioritize item");
  });

  test("rejects completed items", () => {
    const item = makeItem({ status: "completed", completedAt: FIXED_NOW.toISOString() });
    expect(() => reprioritize([item], item.id, "high")).toThrow("Cannot reprioritize item");
  });

  test("throws on no match", () => {
    const item = makeItem();
    expect(() => reprioritize([item], "nonexistent", "high")).toThrow("No item found");
  });

  test("throws on ambiguous prefix", () => {
    const a = makeItem({ id: "abcd0000-repri-0000-0000-000000000000", status: "queued" });
    const b = makeItem({ id: "abcd1111-repri-0000-0000-000000000000", status: "queued" });
    expect(() => reprioritize([a, b], "abcd", "high")).toThrow("Ambiguous id prefix");
  });

  test("returns new items array (does not mutate input)", () => {
    const item = makeItem({ status: "queued" });
    const items = [item];
    const result = reprioritize(items, item.id, "low");

    expect(result.items).not.toBe(items);
    expect(result.items[0]?.priority).toBe("low");
  });

  test("does not mutate the original item or items array", () => {
    const item = makeItem({ status: "queued" });
    const items = [item];
    reprioritize(items, item.id, "low");

    expect(item.priority).toBeUndefined();
    expect(items).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// addTags
// ---------------------------------------------------------------------------

describe("addTags", () => {
  test("adds tags to an item with no existing tags", () => {
    const item = makeItem();
    const result = addTags([item], item.id, ["alpha", "beta"]);

    expect(result.item.tags).toEqual(["alpha", "beta"]);
  });

  test("merges new tags with existing tags", () => {
    const item = makeItem({ tags: ["existing"] });
    const result = addTags([item], item.id, ["new"]);

    expect(result.item.tags).toEqual(["existing", "new"]);
  });

  test("deduplicates tags", () => {
    const item = makeItem({ tags: ["dup"] });
    const result = addTags([item], item.id, ["dup", "new"]);

    expect(result.item.tags).toEqual(["dup", "new"]);
  });

  test("sorts tags alphabetically", () => {
    const item = makeItem({ tags: ["zebra"] });
    const result = addTags([item], item.id, ["apple"]);

    expect(result.item.tags).toEqual(["apple", "zebra"]);
  });

  test("throws on no match", () => {
    const item = makeItem();
    expect(() => addTags([item], "nonexistent", ["tag"])).toThrow("No item found");
  });

  test("does not mutate the original item or items array", () => {
    const item = makeItem({ tags: ["original"] });
    const items = [item];
    addTags(items, item.id, ["new"]);

    expect(item.tags).toEqual(["original"]);
    expect(items).toHaveLength(1);
  });

  test("returns new items array reference", () => {
    const item = makeItem();
    const items = [item];
    const result = addTags(items, item.id, ["tag"]);

    expect(result.items).not.toBe(items);
  });
});

// ---------------------------------------------------------------------------
// removeTags
// ---------------------------------------------------------------------------

describe("removeTags", () => {
  test("removes specified tags from an item", () => {
    const item = makeItem({ tags: ["keep", "remove"] });
    const result = removeTags([item], item.id, ["remove"]);

    expect(result.item.tags).toEqual(["keep"]);
  });

  test("sets tags to undefined when all tags are removed", () => {
    const item = makeItem({ tags: ["only"] });
    const result = removeTags([item], item.id, ["only"]);

    expect(result.item.tags).toBeUndefined();
  });

  test("ignores tags not present on the item", () => {
    const item = makeItem({ tags: ["keep"] });
    const result = removeTags([item], item.id, ["nonexistent"]);

    expect(result.item.tags).toEqual(["keep"]);
  });

  test("handles item with no tags gracefully", () => {
    const item = makeItem();
    const result = removeTags([item], item.id, ["whatever"]);

    expect(result.item.tags).toBeUndefined();
  });

  test("throws on no match", () => {
    const item = makeItem();
    expect(() => removeTags([item], "nonexistent", ["tag"])).toThrow("No item found");
  });

  test("does not mutate the original item or items array", () => {
    const item = makeItem({ tags: ["keep", "remove"] });
    const items = [item];
    removeTags(items, item.id, ["remove"]);

    expect(item.tags).toEqual(["keep", "remove"]);
    expect(items).toHaveLength(1);
  });

  test("returns new items array reference", () => {
    const item = makeItem({ tags: ["tag"] });
    const items = [item];
    const result = removeTags(items, item.id, ["tag"]);

    expect(result.items).not.toBe(items);
  });
});

// ---------------------------------------------------------------------------
// prependItem
// ---------------------------------------------------------------------------

describe("prependItem", () => {
  test("prepends item to empty array", () => {
    const item = makeItem({ title: "New" });
    const result = prependItem([], item);

    expect(result).toHaveLength(1);
    expect(result[0]).toBe(item);
  });

  test("prepends item before existing items", () => {
    const existing = makeItem({ title: "Existing" });
    const newItem = makeItem({ title: "New" });
    const result = prependItem([existing], newItem);

    expect(result).toHaveLength(2);
    expect(result[0]?.title).toBe("New");
    expect(result[1]?.title).toBe("Existing");
  });

  test("does not mutate the original array", () => {
    const original = [makeItem({ title: "Original" })];
    prependItem(original, makeItem({ title: "New" }));

    expect(original).toHaveLength(1);
  });
});
