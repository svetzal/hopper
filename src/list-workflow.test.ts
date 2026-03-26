import { describe, expect, test } from "bun:test";
import { filterAndSortItems, formatItemList, itemTiming } from "./list-workflow.ts";
import type { Item } from "./store.ts";

function makeItem(overrides?: Partial<Item>): Item {
  return {
    id: crypto.randomUUID(),
    title: "Test item",
    description: "A test description",
    status: "queued",
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

describe("filterAndSortItems", () => {
  test("default mode includes queued, in_progress, scheduled, blocked items", () => {
    const items = [
      makeItem({ status: "queued" }),
      makeItem({ status: "in_progress" }),
      makeItem({ status: "scheduled", scheduledAt: new Date().toISOString() }),
      makeItem({ status: "blocked" }),
      makeItem({ status: "completed" }),
      makeItem({ status: "cancelled" }),
    ];

    const result = filterAndSortItems(items, { mode: "default" }, undefined, []);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.items).toHaveLength(4);
      expect(result.items.every((i) => i.status !== "completed" && i.status !== "cancelled")).toBe(
        true,
      );
    }
  });

  test("completed mode includes only completed items", () => {
    const items = [makeItem({ status: "queued" }), makeItem({ status: "completed" })];

    const result = filterAndSortItems(items, { mode: "completed" }, undefined, []);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.items).toHaveLength(1);
      expect(result.items[0]?.status).toBe("completed");
    }
  });

  test("scheduled mode includes only scheduled items", () => {
    const items = [
      makeItem({ status: "queued" }),
      makeItem({ status: "scheduled", scheduledAt: new Date().toISOString() }),
    ];

    const result = filterAndSortItems(items, { mode: "scheduled" }, undefined, []);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.items).toHaveLength(1);
      expect(result.items[0]?.status).toBe("scheduled");
    }
  });

  test("all mode includes all items", () => {
    const items = [
      makeItem({ status: "queued" }),
      makeItem({ status: "completed" }),
      makeItem({ status: "cancelled" }),
    ];

    const result = filterAndSortItems(items, { mode: "all" }, undefined, []);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.items).toHaveLength(3);
    }
  });

  test("returns error for invalid priority filter", () => {
    const items = [makeItem()];
    const result = filterAndSortItems(items, { mode: "default" }, "invalid", []);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBeTruthy();
    }
  });

  test("filters by priority", () => {
    const items = [
      makeItem({ priority: "high" }),
      makeItem({ priority: "normal" }),
      makeItem({ priority: "low" }),
    ];

    const result = filterAndSortItems(items, { mode: "default" }, "high", []);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.items).toHaveLength(1);
      expect(result.items[0]?.priority).toBe("high");
    }
  });

  test("filters by tag", () => {
    const items = [makeItem({ tags: ["frontend"] }), makeItem({ tags: ["backend"] })];

    const result = filterAndSortItems(items, { mode: "default" }, undefined, ["frontend"]);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.items).toHaveLength(1);
      expect(result.items[0]?.tags).toContain("frontend");
    }
  });

  test("sorts by priority then creation time", () => {
    const older = makeItem({ priority: "normal", createdAt: "2025-01-01T00:00:00Z" });
    const newer = makeItem({ priority: "normal", createdAt: "2025-01-02T00:00:00Z" });
    const high = makeItem({ priority: "high", createdAt: "2025-01-03T00:00:00Z" });

    const result = filterAndSortItems([newer, older, high], { mode: "default" }, undefined, []);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.items[0]?.priority).toBe("high");
      expect(result.items[1]?.createdAt).toBe("2025-01-01T00:00:00Z");
      expect(result.items[2]?.createdAt).toBe("2025-01-02T00:00:00Z");
    }
  });
});

describe("formatItemList", () => {
  test("returns empty queue message for empty array", () => {
    expect(formatItemList([])).toBe("Queue is empty.");
  });

  test("includes item title and description snippet", () => {
    const item = makeItem({ title: "My Task", description: "Short desc" });
    const output = formatItemList([item]);

    expect(output).toContain("My Task");
    expect(output).toContain("Short desc");
  });

  test("truncates long descriptions to 80 chars", () => {
    const longDesc = "A".repeat(100);
    const item = makeItem({ description: longDesc });
    const output = formatItemList([item]);

    expect(output).toContain("...");
    expect(output).not.toContain("A".repeat(100));
  });
});

describe("itemTiming", () => {
  test("returns completed duration for completed items", () => {
    const item = makeItem({
      status: "completed",
      claimedAt: "2025-01-01T10:00:00Z",
      completedAt: "2025-01-01T11:00:00Z",
    });

    expect(itemTiming(item)).toContain("completed in");
    expect(itemTiming(item)).toContain("1h");
  });

  test("returns claimed info for in_progress items", () => {
    const item = makeItem({
      status: "in_progress",
      claimedAt: new Date(Date.now() - 10 * 60 * 1000).toISOString(),
      claimedBy: "bot",
    });

    expect(itemTiming(item)).toContain("claimed by bot");
  });

  test("returns added time for other items", () => {
    const item = makeItem({ status: "queued" });
    expect(itemTiming(item)).toContain("added");
  });
});
