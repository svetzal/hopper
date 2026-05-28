/** Type guard: true when `v` is a plain object (not null, not an array). */
export function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
