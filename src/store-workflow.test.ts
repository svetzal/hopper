import { describe, expect, test } from "bun:test";
import type { Item, PhaseRecord } from "./store.ts";
import {
  addTags,
  appendPhase,
  cancel,
  claimNext,
  complete,
  dirsOverlap,
  ensureDefaults,
  normalizeDir,
  prependItem,
  removeTags,
  reprioritize,
  requeue,
  setEngineeringBranchSlug,
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
// normalizeDir / dirsOverlap
// ---------------------------------------------------------------------------

describe("normalizeDir", () => {
  test("strips trailing slashes", () => {
    expect(normalizeDir("/a/b/")).toBe("/a/b");
  });

  test("strips multiple trailing slashes", () => {
    expect(normalizeDir("/a/b///")).toBe("/a/b");
  });

  test("returns path unchanged when no trailing slash", () => {
    expect(normalizeDir("/a/b")).toBe("/a/b");
  });
});

describe("dirsOverlap", () => {
  test("same path overlaps", () => {
    expect(dirsOverlap("/a/b", "/a/b")).toBe(true);
  });

  test("parent contains child", () => {
    expect(dirsOverlap("/a", "/a/b")).toBe(true);
  });

  test("child contained by parent", () => {
    expect(dirsOverlap("/a/b", "/a")).toBe(true);
  });

  test("siblings do not overlap", () => {
    expect(dirsOverlap("/a/b1", "/a/b2")).toBe(false);
  });

  test("no false positive on shared prefix without / boundary", () => {
    expect(dirsOverlap("/a/bc", "/a/b")).toBe(false);
  });

  test("trailing slash normalized before comparison", () => {
    expect(dirsOverlap("/a/b/", "/a/b")).toBe(true);
  });

  test("deeply nested containment", () => {
    expect(dirsOverlap("/a/b/c/d", "/a/b")).toBe(true);
  });

  test("unrelated paths do not overlap", () => {
    expect(dirsOverlap("/x/y", "/a/b")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// claimNext — directory-aware filtering
// ---------------------------------------------------------------------------

describe("claimNext — directory-aware", () => {
  test("skips queued item whose workingDir matches an in-progress item", () => {
    const inProgress = makeItem({
      status: "in_progress",
      workingDir: "/repo/project",
      claimedAt: FIXED_NOW.toISOString(),
    });
    const queued = makeItem({ workingDir: "/repo/project" });
    const result = claimNext([inProgress, queued], undefined, FIXED_NOW, FIXED_UUID);

    expect(result.claimed).toBeUndefined();
  });

  test("claims item with different workingDir when another dir is busy", () => {
    const inProgress = makeItem({
      status: "in_progress",
      workingDir: "/repo/project-a",
      claimedAt: FIXED_NOW.toISOString(),
    });
    const queued = makeItem({ title: "Different dir", workingDir: "/repo/project-b" });
    const result = claimNext([inProgress, queued], undefined, FIXED_NOW, FIXED_UUID);

    expect(result.claimed?.title).toBe("Different dir");
  });

  test("uses cwd as effective dir for items without workingDir", () => {
    const inProgress = makeItem({
      status: "in_progress",
      claimedAt: FIXED_NOW.toISOString(),
      // no workingDir — will use cwd
    });
    const queued = makeItem({ title: "Also no dir" });
    const result = claimNext([inProgress, queued], undefined, FIXED_NOW, FIXED_UUID, "/my/cwd");

    // Both use cwd=/my/cwd as effective dir → queued item is skipped
    expect(result.claimed).toBeUndefined();
  });

  test("containment: skips item at child dir when parent is busy", () => {
    const inProgress = makeItem({
      status: "in_progress",
      workingDir: "/projects",
      claimedAt: FIXED_NOW.toISOString(),
    });
    const queued = makeItem({ workingDir: "/projects/repo" });
    const result = claimNext([inProgress, queued], undefined, FIXED_NOW, FIXED_UUID);

    expect(result.claimed).toBeUndefined();
  });

  test("containment: skips item at parent dir when child is busy", () => {
    const inProgress = makeItem({
      status: "in_progress",
      workingDir: "/projects/repo",
      claimedAt: FIXED_NOW.toISOString(),
    });
    const queued = makeItem({ workingDir: "/projects" });
    const result = claimNext([inProgress, queued], undefined, FIXED_NOW, FIXED_UUID);

    expect(result.claimed).toBeUndefined();
  });

  test("no false positive: sibling dirs do not block each other", () => {
    const inProgress = makeItem({
      status: "in_progress",
      workingDir: "/projects/repo1",
      claimedAt: FIXED_NOW.toISOString(),
    });
    const queued = makeItem({ title: "Sibling", workingDir: "/projects/repo2" });
    const result = claimNext([inProgress, queued], undefined, FIXED_NOW, FIXED_UUID);

    expect(result.claimed?.title).toBe("Sibling");
  });

  test("trailing slash normalized: /a/b/ treated same as /a/b", () => {
    const inProgress = makeItem({
      status: "in_progress",
      workingDir: "/repo/project/",
      claimedAt: FIXED_NOW.toISOString(),
    });
    const queued = makeItem({ workingDir: "/repo/project" });
    const result = claimNext([inProgress, queued], undefined, FIXED_NOW, FIXED_UUID);

    expect(result.claimed).toBeUndefined();
  });

  test("multiple busy dirs: only overlapping candidates skipped", () => {
    const busyA = makeItem({
      status: "in_progress",
      workingDir: "/repo/a",
      claimedAt: FIXED_NOW.toISOString(),
    });
    const busyB = makeItem({
      status: "in_progress",
      workingDir: "/repo/b",
      claimedAt: FIXED_NOW.toISOString(),
    });
    const queuedA = makeItem({ title: "Blocked by A", workingDir: "/repo/a" });
    const queuedB = makeItem({ title: "Blocked by B", workingDir: "/repo/b" });
    const queuedC = makeItem({ title: "Free", workingDir: "/repo/c" });
    const result = claimNext(
      [busyA, busyB, queuedA, queuedB, queuedC],
      undefined,
      FIXED_NOW,
      FIXED_UUID,
    );

    expect(result.claimed?.title).toBe("Free");
  });

  test("no cwd provided: items without workingDir are freely claimable", () => {
    const inProgress = makeItem({
      status: "in_progress",
      workingDir: "/repo/project",
      claimedAt: FIXED_NOW.toISOString(),
    });
    const queued = makeItem({ title: "No dir" });
    // No cwd argument — no-dir items are ungrouped
    const result = claimNext([inProgress, queued], undefined, FIXED_NOW, FIXED_UUID);

    expect(result.claimed?.title).toBe("No dir");
  });

  test("same workingDir different branch still serialized", () => {
    const inProgress = makeItem({
      status: "in_progress",
      workingDir: "/repo/project",
      branch: "feat/a",
      claimedAt: FIXED_NOW.toISOString(),
    });
    const queued = makeItem({ workingDir: "/repo/project", branch: "feat/b" });
    const result = claimNext([inProgress, queued], undefined, FIXED_NOW, FIXED_UUID);

    expect(result.claimed).toBeUndefined();
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

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.completed.status).toBe("completed");
      expect(result.value.completed.completedAt).toBe(FIXED_NOW.toISOString());
      expect(result.value.completed.completedBy).toBe("agent");
    }
  });

  test("returns error on invalid token", () => {
    const item = makeInProgressItem();
    const result = complete([item], "bad-token", "agent", undefined, FIXED_NOW, "new-uuid");

    expect(result).toMatchObject({
      ok: false,
      error: expect.stringContaining("No in-progress item found"),
    });
  });

  test("returns error when item is not in_progress", () => {
    const item = makeItem({ status: "queued", claimToken: FIXED_UUID });
    const result = complete([item], FIXED_UUID, "agent", undefined, FIXED_NOW, "new-uuid");

    expect(result).toMatchObject({ ok: false, error: expect.stringContaining("not in progress") });
  });

  test("stores result when provided", () => {
    const item = makeInProgressItem();
    const result = complete([item], FIXED_UUID, "agent", "Fixed the bug", FIXED_NOW, "new-uuid");

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.completed.result).toBe("Fixed the bug");
    }
  });

  test("result is undefined when not provided", () => {
    const item = makeInProgressItem();
    const result = complete([item], FIXED_UUID, "agent", undefined, FIXED_NOW, "new-uuid");

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.completed.result).toBeUndefined();
    }
  });

  test("clears claim token after completion", () => {
    const item = makeInProgressItem();
    const result = complete([item], FIXED_UUID, "agent", undefined, FIXED_NOW, "new-uuid");

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.completed.claimToken).toBeUndefined();
    }
  });

  test("unblocks single-dependency blocked item to queued", () => {
    const dep = makeInProgressItem({ id: "dep-id-0000-0000-0000-000000000001" });
    const blocked = makeItem({
      id: "blocked-id-0000-0000-0000-000000000001",
      status: "blocked",
      dependsOn: [dep.id],
    });
    const result = complete([dep, blocked], FIXED_UUID, "agent", undefined, FIXED_NOW, "new-uuid");

    expect(result.ok).toBe(true);
    if (result.ok) {
      const updatedBlocked = result.value.items.find((i) => i.id === blocked.id);
      expect(updatedBlocked?.status).toBe("queued");
    }
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

    expect(result.ok).toBe(true);
    if (result.ok) {
      const updatedBlocked = result.value.items.find((i) => i.id === blocked.id);
      expect(updatedBlocked?.status).toBe("scheduled");
    }
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

    expect(result.ok).toBe(true);
    if (result.ok) {
      const updatedBlocked = result.value.items.find((i) => i.id === blocked.id);
      expect(updatedBlocked?.status).toBe("blocked");
    }
  });

  test("recurrence creates new scheduled item with decremented remainingRuns", () => {
    const item = makeInProgressItem({
      title: "Recurring",
      recurrence: { interval: "4h", intervalMs: 4 * 3_600_000, remainingRuns: 2 },
    });
    const result = complete([item], FIXED_UUID, "agent", undefined, FIXED_NOW, "recurred-uuid");

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.recurred).toBeDefined();
      expect(result.value.recurred?.status).toBe("scheduled");
      expect(result.value.recurred?.recurrence?.remainingRuns).toBe(1);
      expect(result.value.recurred?.id).toBe("recurred-uuid");
    }
  });

  test("recurrence stops when remainingRuns is 0", () => {
    const item = makeInProgressItem({
      recurrence: { interval: "1h", intervalMs: 3_600_000, remainingRuns: 0 },
    });
    const result = complete([item], FIXED_UUID, "agent", undefined, FIXED_NOW, "recurred-uuid");

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.recurred).toBeUndefined();
    }
  });

  test("recurrence stops when until has passed", () => {
    const expiredUntil = new Date(FIXED_NOW.getTime() - 1000).toISOString();
    const item = makeInProgressItem({
      recurrence: { interval: "1h", intervalMs: 3_600_000, until: expiredUntil },
    });
    const result = complete([item], FIXED_UUID, "agent", undefined, FIXED_NOW, "recurred-uuid");

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.recurred).toBeUndefined();
    }
  });

  test("recurrence continues when remainingRuns is not set", () => {
    const item = makeInProgressItem({
      recurrence: { interval: "1h", intervalMs: 3_600_000 },
    });
    const result = complete([item], FIXED_UUID, "agent", undefined, FIXED_NOW, "recurred-uuid");

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.recurred).toBeDefined();
      expect(result.value.recurred?.recurrence?.remainingRuns).toBeUndefined();
    }
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

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.recurred?.workingDir).toBe("/tmp/project");
      expect(result.value.recurred?.branch).toBe("main");
      expect(result.value.recurred?.priority).toBe("high");
      expect(result.value.recurred?.command).toBe("make test");
      expect(result.value.recurred?.tags).toEqual(["tag1", "tag2"]);
    }
  });

  test("recurred item preserves type, agent, and retries", () => {
    const item = makeInProgressItem({
      type: "engineering",
      agent: "typescript-craftsperson",
      retries: 3,
      recurrence: { interval: "1h", intervalMs: 3_600_000 },
    });
    const result = complete([item], FIXED_UUID, "agent", undefined, FIXED_NOW, "recurred-uuid");

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.recurred?.type).toBe("engineering");
      expect(result.value.recurred?.agent).toBe("typescript-craftsperson");
      expect(result.value.recurred?.retries).toBe(3);
    }
  });

  test("recurred item has scheduledAt = now + intervalMs", () => {
    const item = makeInProgressItem({
      recurrence: { interval: "4h", intervalMs: 4 * 3_600_000 },
    });
    const result = complete([item], FIXED_UUID, "agent", undefined, FIXED_NOW, "recurred-uuid");

    expect(result.ok).toBe(true);
    if (result.ok) {
      const expectedScheduledAt = new Date(FIXED_NOW.getTime() + 4 * 3_600_000).toISOString();
      expect(result.value.recurred?.scheduledAt).toBe(expectedScheduledAt);
    }
  });

  test("recurred item is prepended to the items array", () => {
    const item = makeInProgressItem({
      recurrence: { interval: "1h", intervalMs: 3_600_000 },
    });
    const result = complete([item], FIXED_UUID, "agent", undefined, FIXED_NOW, "recurred-uuid");

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.items[0]?.id).toBe("recurred-uuid");
      expect(result.value.items).toHaveLength(2);
    }
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

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.items).not.toBe(items);
      expect(result.value.items[0]?.status).toBe("completed");
    }
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

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.requeued.status).toBe("queued");
      expect(result.value.requeued.requeueReason).toBe("needs more info");
      expect(result.value.requeued.requeuedBy).toBe("agent");
    }
  });

  test("clears claim fields after requeue", () => {
    const item = makeItem({
      status: "in_progress",
      claimedAt: FIXED_NOW.toISOString(),
      claimedBy: "agent",
      claimToken: FIXED_UUID,
    });
    const result = requeue([item], item.id, "blocked", "agent");

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.requeued.claimedAt).toBeUndefined();
      expect(result.value.requeued.claimedBy).toBeUndefined();
      expect(result.value.requeued.claimToken).toBeUndefined();
    }
  });

  test("returns error for non-in_progress items", () => {
    const item = makeItem({ status: "queued" });
    const result = requeue([item], item.id, "reason", undefined);

    expect(result).toMatchObject({ ok: false, error: expect.stringContaining("not in progress") });
  });

  test("returns error on no match", () => {
    const item = makeItem();
    const result = requeue([item], "nonexistent", "reason", undefined);

    expect(result).toMatchObject({ ok: false, error: expect.stringContaining("No item found") });
  });

  test("returns error on ambiguous prefix", () => {
    const a = makeItem({ id: "abcd0000-0000-0000-0000-000000000000", status: "in_progress" });
    const b = makeItem({ id: "abcd1111-0000-0000-0000-000000000000", status: "in_progress" });
    const result = requeue([a, b], "abcd", "reason", undefined);

    expect(result).toMatchObject({
      ok: false,
      error: expect.stringContaining("Ambiguous id prefix"),
    });
  });

  test("preserves createdAt", () => {
    const originalCreatedAt = "2025-01-01T00:00:00Z";
    const item = makeItem({
      createdAt: originalCreatedAt,
      status: "in_progress",
      claimToken: FIXED_UUID,
    });
    const result = requeue([item], item.id, "reason", undefined);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.requeued.createdAt).toBe(originalCreatedAt);
    }
  });

  test("returns new items array (does not mutate input)", () => {
    const item = makeItem({ status: "in_progress", claimToken: FIXED_UUID });
    const items = [item];
    const result = requeue(items, item.id, "reason", undefined);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.items).not.toBe(items);
      expect(result.value.items[0]?.status).toBe("queued");
    }
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

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.cancelled.status).toBe("cancelled");
      expect(result.value.cancelled.cancelledAt).toBe(FIXED_NOW.toISOString());
      expect(result.value.cancelled.title).toBe("To cancel");
    }
  });

  test("cancels a scheduled item", () => {
    const futureDate = new Date(FIXED_NOW.getTime() + 3_600_000).toISOString();
    const item = makeItem({ status: "scheduled", scheduledAt: futureDate });
    const result = cancel([item], item.id, FIXED_NOW);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.cancelled.status).toBe("cancelled");
    }
  });

  test("cancels a blocked item", () => {
    const dep = makeItem({ id: "dep-id-cancel-0000-0000-0000-000000000001" });
    const blocked = makeItem({
      status: "blocked",
      dependsOn: [dep.id],
    });
    const result = cancel([dep, blocked], blocked.id, FIXED_NOW);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.cancelled.status).toBe("cancelled");
    }
  });

  test("returns error for in_progress items", () => {
    const item = makeItem({ status: "in_progress", claimedAt: FIXED_NOW.toISOString() });
    const result = cancel([item], item.id, FIXED_NOW);

    expect(result).toMatchObject({
      ok: false,
      error: expect.stringContaining("Cannot cancel item"),
    });
  });

  test("returns error for completed items", () => {
    const item = makeItem({ status: "completed", completedAt: FIXED_NOW.toISOString() });
    const result = cancel([item], item.id, FIXED_NOW);

    expect(result).toMatchObject({
      ok: false,
      error: expect.stringContaining("Only queued, scheduled, or blocked items can be cancelled"),
    });
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

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.blockedDependentCount).toBe(2);
    }
  });

  test("returns 0 blocked dependent count when none", () => {
    const item = makeItem({ status: "queued" });
    const result = cancel([item], item.id, FIXED_NOW);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.blockedDependentCount).toBe(0);
    }
  });

  test("prefix matching works", () => {
    const item = makeItem({ id: "abcd1234-cancel-0000-0000-000000000000", title: "Cancel me" });
    const result = cancel([item], "abcd1234", FIXED_NOW);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.cancelled.title).toBe("Cancel me");
      expect(result.value.cancelled.status).toBe("cancelled");
    }
  });

  test("returns error on no match", () => {
    const item = makeItem();
    const result = cancel([item], "nonexistent", FIXED_NOW);

    expect(result).toMatchObject({ ok: false, error: expect.stringContaining("No item found") });
  });

  test("returns error on ambiguous prefix", () => {
    const a = makeItem({ id: "abcd0000-cancel-0000-0000-000000000000" });
    const b = makeItem({ id: "abcd1111-cancel-0000-0000-000000000000" });
    const result = cancel([a, b], "abcd", FIXED_NOW);

    expect(result).toMatchObject({
      ok: false,
      error: expect.stringContaining("Ambiguous id prefix"),
    });
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

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.items).not.toBe(items);
      expect(result.value.items[0]?.status).toBe("cancelled");
    }
  });
});

// ---------------------------------------------------------------------------
// reprioritize
// ---------------------------------------------------------------------------

describe("reprioritize", () => {
  test("changes priority on a queued item", () => {
    const item = makeItem({ status: "queued" });
    const result = reprioritize([item], item.id, "high");

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.item.priority).toBe("high");
      expect(result.value.oldPriority).toBe("normal");
    }
  });

  test("changes priority on a scheduled item", () => {
    const item = makeItem({
      status: "scheduled",
      scheduledAt: new Date(FIXED_NOW.getTime() + 3_600_000).toISOString(),
    });
    const result = reprioritize([item], item.id, "low");

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.item.priority).toBe("low");
    }
  });

  test("returns correct oldPriority when item had explicit priority", () => {
    const item = makeItem({ status: "queued", priority: "high" });
    const result = reprioritize([item], item.id, "low");

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.oldPriority).toBe("high");
    }
  });

  test("oldPriority defaults to normal when item had no priority set", () => {
    const item = makeItem({ status: "queued" });
    const result = reprioritize([item], item.id, "low");

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.oldPriority).toBe("normal");
    }
  });

  test("returns error for in_progress items", () => {
    const item = makeItem({ status: "in_progress", claimedAt: FIXED_NOW.toISOString() });
    const result = reprioritize([item], item.id, "high");

    expect(result).toMatchObject({
      ok: false,
      error: expect.stringContaining("Cannot reprioritize item"),
    });
  });

  test("returns error for completed items", () => {
    const item = makeItem({ status: "completed", completedAt: FIXED_NOW.toISOString() });
    const result = reprioritize([item], item.id, "high");

    expect(result).toMatchObject({
      ok: false,
      error: expect.stringContaining("Cannot reprioritize item"),
    });
  });

  test("returns error on no match", () => {
    const item = makeItem();
    const result = reprioritize([item], "nonexistent", "high");

    expect(result).toMatchObject({ ok: false, error: expect.stringContaining("No item found") });
  });

  test("returns error on ambiguous prefix", () => {
    const a = makeItem({ id: "abcd0000-repri-0000-0000-000000000000", status: "queued" });
    const b = makeItem({ id: "abcd1111-repri-0000-0000-000000000000", status: "queued" });
    const result = reprioritize([a, b], "abcd", "high");

    expect(result).toMatchObject({
      ok: false,
      error: expect.stringContaining("Ambiguous id prefix"),
    });
  });

  test("returns new items array (does not mutate input)", () => {
    const item = makeItem({ status: "queued" });
    const items = [item];
    const result = reprioritize(items, item.id, "low");

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.items).not.toBe(items);
      expect(result.value.items[0]?.priority).toBe("low");
    }
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

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.item.tags).toEqual(["alpha", "beta"]);
    }
  });

  test("merges new tags with existing tags", () => {
    const item = makeItem({ tags: ["existing"] });
    const result = addTags([item], item.id, ["new"]);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.item.tags).toEqual(["existing", "new"]);
    }
  });

  test("deduplicates tags", () => {
    const item = makeItem({ tags: ["dup"] });
    const result = addTags([item], item.id, ["dup", "new"]);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.item.tags).toEqual(["dup", "new"]);
    }
  });

  test("sorts tags alphabetically", () => {
    const item = makeItem({ tags: ["zebra"] });
    const result = addTags([item], item.id, ["apple"]);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.item.tags).toEqual(["apple", "zebra"]);
    }
  });

  test("returns error on no match", () => {
    const item = makeItem();
    const result = addTags([item], "nonexistent", ["tag"]);

    expect(result).toMatchObject({ ok: false, error: expect.stringContaining("No item found") });
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

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.items).not.toBe(items);
    }
  });
});

// ---------------------------------------------------------------------------
// removeTags
// ---------------------------------------------------------------------------

describe("removeTags", () => {
  test("removes specified tags from an item", () => {
    const item = makeItem({ tags: ["keep", "remove"] });
    const result = removeTags([item], item.id, ["remove"]);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.item.tags).toEqual(["keep"]);
    }
  });

  test("sets tags to undefined when all tags are removed", () => {
    const item = makeItem({ tags: ["only"] });
    const result = removeTags([item], item.id, ["only"]);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.item.tags).toBeUndefined();
    }
  });

  test("ignores tags not present on the item", () => {
    const item = makeItem({ tags: ["keep"] });
    const result = removeTags([item], item.id, ["nonexistent"]);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.item.tags).toEqual(["keep"]);
    }
  });

  test("handles item with no tags gracefully", () => {
    const item = makeItem();
    const result = removeTags([item], item.id, ["whatever"]);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.item.tags).toBeUndefined();
    }
  });

  test("returns error on no match", () => {
    const item = makeItem();
    const result = removeTags([item], "nonexistent", ["tag"]);

    expect(result).toMatchObject({ ok: false, error: expect.stringContaining("No item found") });
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

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.items).not.toBe(items);
    }
  });
});

// ---------------------------------------------------------------------------
// prependItem
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// ensureDefaults
// ---------------------------------------------------------------------------

describe("ensureDefaults", () => {
  test("item with existing status is returned unchanged", () => {
    const raw = {
      id: "test-id",
      title: "Test",
      description: "desc",
      status: "completed",
      createdAt: "2025-01-01T00:00:00Z",
    };
    const result = ensureDefaults(raw);
    expect(result.status).toBe("completed");
  });

  test("item missing status gets Status.QUEUED", () => {
    const raw = {
      id: "test-id",
      title: "Test",
      description: "desc",
      createdAt: "2025-01-01T00:00:00Z",
    };
    const result = ensureDefaults(raw as Record<string, unknown>);
    expect(result.status).toBe("queued");
  });
});

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

describe("appendPhase", () => {
  function makePhase(overrides?: Partial<PhaseRecord>): PhaseRecord {
    return {
      name: "plan",
      startedAt: "2026-04-12T10:00:00Z",
      endedAt: "2026-04-12T10:00:30Z",
      exitCode: 0,
      ...overrides,
    };
  }

  test("returns changed: false when the item is not found", () => {
    const items = [makeItem()];
    const result = appendPhase(items, "non-existent-id", makePhase());
    expect(result.changed).toBe(false);
    expect(result.items).toBe(items);
  });

  test("appends the first phase record to an item with no phases", () => {
    const item = makeItem();
    const phase = makePhase();
    const result = appendPhase([item], item.id, phase);
    expect(result.changed).toBe(true);
    const updated = result.items.find((i) => i.id === item.id);
    expect(updated?.phases).toEqual([phase]);
  });

  test("appends additional phases in insertion order", () => {
    const item = makeItem();
    const plan = makePhase({ name: "plan" });
    const execute = makePhase({ name: "execute" });
    const firstPass = appendPhase([item], item.id, plan);
    const secondPass = appendPhase(firstPass.items, item.id, execute);

    const updated = secondPass.items.find((i) => i.id === item.id);
    expect(updated?.phases?.map((p) => p.name)).toEqual(["plan", "execute"]);
  });

  test("replaces an existing record when the same {name, attempt} is recorded again", () => {
    const item = makeItem();
    const first = makePhase({ name: "plan", exitCode: 1 });
    const retry = makePhase({
      name: "plan",
      exitCode: 0,
      startedAt: "2026-04-12T11:00:00Z",
      endedAt: "2026-04-12T11:00:20Z",
    });

    const afterFirst = appendPhase([item], item.id, first);
    const afterRetry = appendPhase(afterFirst.items, item.id, retry);

    const updated = afterRetry.items.find((i) => i.id === item.id);
    expect(updated?.phases).toHaveLength(1);
    expect(updated?.phases?.[0]?.exitCode).toBe(0);
    expect(updated?.phases?.[0]?.startedAt).toBe("2026-04-12T11:00:00Z");
  });

  test("keeps both records when same phase name is recorded at different attempts", () => {
    const item = makeItem();
    const first = makePhase({ name: "execute", attempt: 1, exitCode: 0 });
    const second = makePhase({ name: "execute", attempt: 2, exitCode: 0 });

    const afterFirst = appendPhase([item], item.id, first);
    const afterSecond = appendPhase(afterFirst.items, item.id, second);

    const updated = afterSecond.items.find((i) => i.id === item.id);
    expect(updated?.phases).toHaveLength(2);
    expect(updated?.phases?.map((p) => p.attempt)).toEqual([1, 2]);
  });

  test("treats missing attempt as attempt 1 for dedup purposes", () => {
    const item = makeItem();
    const implicit = makePhase({ name: "execute" }); // attempt implicitly 1
    const explicit = makePhase({ name: "execute", attempt: 1, exitCode: 5 });

    const afterFirst = appendPhase([item], item.id, implicit);
    const afterSecond = appendPhase(afterFirst.items, item.id, explicit);

    const updated = afterSecond.items.find((i) => i.id === item.id);
    expect(updated?.phases).toHaveLength(1);
    expect(updated?.phases?.[0]?.exitCode).toBe(5);
  });

  test("does not mutate the input items array", () => {
    const item = makeItem();
    const items = [item];
    const original = [...items];
    appendPhase(items, item.id, makePhase());
    expect(items).toEqual(original);
    expect(items[0]?.phases).toBeUndefined();
  });

  test("preserves other items in the array untouched", () => {
    const a = makeItem({ title: "A" });
    const b = makeItem({ title: "B" });
    const result = appendPhase([a, b], b.id, makePhase());
    expect(result.items.find((i) => i.id === a.id)).toBe(a);
    expect(result.items.find((i) => i.id === b.id)?.phases).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// setEngineeringBranchSlug
// ---------------------------------------------------------------------------

describe("setEngineeringBranchSlug", () => {
  test("returns changed: false when the item is not found", () => {
    const items = [makeItem()];
    const result = setEngineeringBranchSlug(items, "non-existent-id", "my-feature");
    expect(result.changed).toBe(false);
    expect(result.items).toBe(items);
  });

  test("sets the slug on first call and returns changed: true", () => {
    const item = makeItem();
    const result = setEngineeringBranchSlug([item], item.id, "my-feature");
    expect(result.changed).toBe(true);
    const updated = result.items.find((i) => i.id === item.id);
    expect(updated?.engineeringBranchSlug).toBe("my-feature");
  });

  test("returns changed: false when slug already equals the new value (idempotent)", () => {
    const item = makeItem({ engineeringBranchSlug: "cached-slug" });
    const items = [item];
    const result = setEngineeringBranchSlug(items, item.id, "cached-slug");
    expect(result.changed).toBe(false);
    expect(result.items).toBe(items);
  });

  test("replaces an existing slug with a new value", () => {
    const item = makeItem({ engineeringBranchSlug: "old-slug" });
    const result = setEngineeringBranchSlug([item], item.id, "new-slug");
    expect(result.changed).toBe(true);
    const updated = result.items.find((i) => i.id === item.id);
    expect(updated?.engineeringBranchSlug).toBe("new-slug");
  });

  test("does not mutate the input items array", () => {
    const item = makeItem();
    const items = [item];
    const original = [...items];
    setEngineeringBranchSlug(items, item.id, "my-feature");
    expect(items).toEqual(original);
    expect(items[0]?.engineeringBranchSlug).toBeUndefined();
  });

  test("preserves other items in the array untouched", () => {
    const a = makeItem({ title: "A" });
    const b = makeItem({ title: "B" });
    const result = setEngineeringBranchSlug([a, b], b.id, "slug-for-b");
    expect(result.items.find((i) => i.id === a.id)).toBe(a);
    expect(result.items.find((i) => i.id === b.id)?.engineeringBranchSlug).toBe("slug-for-b");
  });
});
