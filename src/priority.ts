export type Priority = "high" | "normal" | "low";

const PRIORITY_MAP: Record<string, Priority> = {
  high: "high",
  h: "high",
  hi: "high",
  normal: "normal",
  n: "normal",
  low: "low",
  l: "low",
  lo: "low",
};

export function parsePriority(value: string): Priority {
  const normalized = PRIORITY_MAP[value.toLowerCase()];
  if (!normalized) {
    throw new Error(`Invalid priority '${value}'. Use high, normal, or low.`);
  }
  return normalized;
}

export function priorityBadge(priority: Priority | undefined): string {
  if (priority === "high") return " [\u{1F534} high]";
  if (priority === "low") return " [\u{1F535} low]";
  return "";
}

const PRIORITY_ORDER: Record<Priority, number> = { high: 0, normal: 1, low: 2 };

/**
 * Compare two priorities for sorting. Returns negative if `a` sorts before `b`,
 * positive if `a` sorts after `b`, zero if equal.
 * Undefined priorities are treated as 'normal'.
 */
export function comparePriority(a: Priority | undefined, b: Priority | undefined): number {
  return PRIORITY_ORDER[a ?? "normal"] - PRIORITY_ORDER[b ?? "normal"];
}
