import { describe, expect, test } from "bun:test";
import { filterAndSortItems, formatItemList, itemTiming, taskTypeBadge } from "./list-workflow.ts";
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
      expect(result.value).toHaveLength(4);
      expect(result.value.every((i) => i.status !== "completed" && i.status !== "cancelled")).toBe(
        true,
      );
    }
  });

  test("completed mode includes only completed items", () => {
    const items = [makeItem({ status: "queued" }), makeItem({ status: "completed" })];

    const result = filterAndSortItems(items, { mode: "completed" }, undefined, []);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toHaveLength(1);
      expect(result.value[0]?.status).toBe("completed");
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
      expect(result.value).toHaveLength(1);
      expect(result.value[0]?.status).toBe("scheduled");
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
      expect(result.value).toHaveLength(3);
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
      expect(result.value).toHaveLength(1);
      expect(result.value[0]?.priority).toBe("high");
    }
  });

  test("filters by tag", () => {
    const items = [makeItem({ tags: ["frontend"] }), makeItem({ tags: ["backend"] })];

    const result = filterAndSortItems(items, { mode: "default" }, undefined, ["frontend"]);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toHaveLength(1);
      expect(result.value[0]?.tags).toContain("frontend");
    }
  });

  test("filters by task type (investigation)", () => {
    const items = [
      makeItem({ title: "Inv", type: "investigation" }),
      makeItem({ title: "Eng", type: "engineering" }),
      makeItem({ title: "Legacy" }),
    ];

    const result = filterAndSortItems(items, { mode: "default" }, undefined, [], "investigation");

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toHaveLength(1);
      expect(result.value[0]?.title).toBe("Inv");
    }
  });

  test("filters by task type treats undefined as 'task' (legacy items)", () => {
    const items = [
      makeItem({ title: "Inv", type: "investigation" }),
      makeItem({ title: "Legacy" }),
    ];

    const result = filterAndSortItems(items, { mode: "default" }, undefined, [], "task");

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toHaveLength(1);
      expect(result.value[0]?.title).toBe("Legacy");
    }
  });

  test("rejects invalid type filter", () => {
    const items = [makeItem()];
    const result = filterAndSortItems(items, { mode: "default" }, undefined, [], "spike");

    expect(result.ok).toBe(false);
  });

  test("sorts by priority then creation time", () => {
    const older = makeItem({ priority: "normal", createdAt: "2025-01-01T00:00:00Z" });
    const newer = makeItem({ priority: "normal", createdAt: "2025-01-02T00:00:00Z" });
    const high = makeItem({ priority: "high", createdAt: "2025-01-03T00:00:00Z" });

    const result = filterAndSortItems([newer, older, high], { mode: "default" }, undefined, []);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value[0]?.priority).toBe("high");
      expect(result.value[1]?.createdAt).toBe("2025-01-01T00:00:00Z");
      expect(result.value[2]?.createdAt).toBe("2025-01-02T00:00:00Z");
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

  test("renders [inv] badge for investigation items", () => {
    const item = makeItem({ title: "My Task", type: "investigation" });
    expect(formatItemList([item])).toContain("[inv]");
  });

  test("renders [eng] badge for engineering items", () => {
    const item = makeItem({ title: "My Task", type: "engineering" });
    expect(formatItemList([item])).toContain("[eng]");
  });

  test("omits type badge for legacy (undefined) items", () => {
    const item = makeItem({ title: "My Task" });
    const output = formatItemList([item]);
    expect(output).not.toContain("[inv]");
    expect(output).not.toContain("[eng]");
  });
});

describe("taskTypeBadge", () => {
  test("investigation -> [inv]", () => {
    expect(taskTypeBadge("investigation")).toBe(" [inv]");
  });
  test("engineering -> [eng]", () => {
    expect(taskTypeBadge("engineering")).toBe(" [eng]");
  });
  test("task -> empty", () => {
    expect(taskTypeBadge("task")).toBe("");
  });
  test("undefined -> empty", () => {
    expect(taskTypeBadge(undefined)).toBe("");
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
