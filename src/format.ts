export function relativeTime(iso: string, nowMs: number = Date.now()): string {
  const then = new Date(iso).getTime();
  const diffMs = nowMs - then;
  const diffSec = Math.floor(diffMs / 1000);

  if (diffSec < 60) return "just now";
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;
  const diffDay = Math.floor(diffHr / 24);
  return `${diffDay}d ago`;
}

export function relativeTimeFuture(iso: string, nowMs: number = Date.now()): string {
  const then = new Date(iso).getTime();
  const diffMs = then - nowMs;

  if (diffMs <= 0) return "now";
  const diffSec = Math.floor(diffMs / 1000);
  if (diffSec < 60) return `in ${diffSec}s`;
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `in ${diffMin}m`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `in ${diffHr}h`;
  const diffDay = Math.floor(diffHr / 24);
  return `in ${diffDay}d`;
}

export function formatDuration(startIso: string, endIso: string): string {
  const startMs = new Date(startIso).getTime();
  const endMs = new Date(endIso).getTime();
  const diffMin = Math.floor((endMs - startMs) / 60000);

  if (diffMin < 60) return `${diffMin}m`;
  const hours = Math.floor(diffMin / 60);
  const mins = diffMin % 60;
  if (mins === 0) return `${hours}h`;
  return `${hours}h ${mins}m`;
}

export function shortId(uuid: string): string {
  return uuid.slice(0, 8);
}

import type { Item, PhaseRecord } from "./store.ts";

/**
 * Render the per-phase status strip for an engineering item, e.g.
 *   "plan ✓ 34s / execute ✓ 2m11s / validate ✗ FAIL / execute ✓ 45s / validate ✓ 20s"
 *
 * Returns an empty string when there are no phase records yet. Phases are
 * ordered by attempt (ascending), with `plan` always first since it has no
 * retries. Within an attempt, the canonical plan → execute → validate order
 * is preserved. This mirrors the temporal order the worker actually ran
 * things, which is what a reader wants to see.
 */
export function formatPhasesStatus(phases: PhaseRecord[] | undefined): string {
  if (!phases || phases.length === 0) return "";
  const valid: Array<PhaseRecord["name"]> = ["plan", "execute", "validate"];
  const attemptOf = (p: PhaseRecord): number => p.attempt ?? 1;
  const rankByName = (name: PhaseRecord["name"]): number => valid.indexOf(name);

  const sorted = phases
    .filter((p) => valid.includes(p.name))
    .sort((a, b) => {
      const attemptDiff = attemptOf(a) - attemptOf(b);
      if (attemptDiff !== 0) return attemptDiff;
      return rankByName(a.name) - rankByName(b.name);
    });

  const segments: string[] = [];
  for (const p of sorted) {
    // Validate has an explicit passed?: boolean; plan/execute infer from exit.
    const ok = p.name === "validate" ? p.passed === true : p.exitCode === 0;
    const marker = ok ? "✓" : "✗";
    const duration = formatDuration(p.startedAt, p.endedAt);
    const shownDuration = duration === "0m" ? "<1m" : duration;
    const failSuffix = !ok && p.name === "validate" && p.passed === false ? " FAIL" : "";
    segments.push(`${p.name} ${marker} ${shownDuration}${failSuffix}`);
  }
  return segments.join(" / ");
}

/** Format full details of an item as a multi-line string (for the show command). */
export function formatItemDetail(item: Item): string {
  const lines: string[] = [];
  lines.push(`ID:          ${shortId(item.id)}`);
  lines.push(`Title:       ${item.title}`);
  lines.push(`Status:      ${item.status}`);
  if (item.type) lines.push(`Type:        ${item.type}`);
  if (item.agent) lines.push(`Agent:       ${item.agent}`);
  if (item.retries !== undefined) lines.push(`Retries:     ${item.retries}`);
  lines.push(`Created:     ${item.createdAt}`);
  if (item.claimedAt) lines.push(`Claimed:     ${item.claimedAt}`);
  if (item.claimedBy) lines.push(`Claimed by:  ${item.claimedBy}`);
  if (item.completedAt) lines.push(`Completed:   ${item.completedAt}`);
  if (item.completedBy) lines.push(`Completed by: ${item.completedBy}`);
  if (item.tags?.length) lines.push(`Tags:        ${item.tags.join(", ")}`);
  if (item.scheduledAt) lines.push(`Scheduled:   ${item.scheduledAt}`);
  if (item.workingDir) lines.push(`Directory:   ${item.workingDir}`);
  if (item.command) lines.push(`Command:     ${item.command}`);
  if (item.recurrence) {
    let recurrenceStr = `every ${item.recurrence.interval}`;
    if (item.recurrence.remainingRuns !== undefined) {
      recurrenceStr += ` (${item.recurrence.remainingRuns} runs remaining)`;
    }
    if (item.recurrence.until) {
      recurrenceStr += ` until ${item.recurrence.until}`;
    }
    lines.push(`Recurrence:  ${recurrenceStr}`);
  }
  if (item.dependsOn?.length)
    lines.push(`Depends on:  ${item.dependsOn.map((id) => shortId(id)).join(", ")}`);
  if (item.requeueReason) lines.push(`Requeue reason: ${item.requeueReason}`);
  if (item.requeuedBy) lines.push(`Requeued by: ${item.requeuedBy}`);
  // Engineering items run a plan → execute → validate workflow; each phase
  // writes its own audit file. Surface the canonical locations so coordinators
  // know exactly where to read per-phase traces without computing them from
  // the item ID. Paths use a literal `~/.hopper/audit/` — this is display copy,
  // not a filesystem argument, and matches the skill documentation.
  if (item.type === "engineering") {
    const phases = formatPhasesStatus(item.phases);
    if (phases) lines.push(`Phases:       ${phases}`);
    lines.push(`Plan file:    ~/.hopper/audit/${item.id}-plan.md`);
    lines.push(`Plan audit:   ~/.hopper/audit/${item.id}-plan.jsonl`);
    lines.push(`Exec audit:   ~/.hopper/audit/${item.id}-execute.jsonl`);
    lines.push(`Valid audit:  ~/.hopper/audit/${item.id}-validate.jsonl`);
  }
  lines.push("");
  lines.push("Description:");
  lines.push(`  ${item.description}`);
  if (item.result) {
    lines.push("");
    lines.push("Result:");
    lines.push(`  ${item.result}`);
  }
  return lines.join("\n");
}
