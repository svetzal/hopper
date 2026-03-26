export function relativeTime(iso: string): string {
  const now = Date.now();
  const then = new Date(iso).getTime();
  const diffMs = now - then;
  const diffSec = Math.floor(diffMs / 1000);

  if (diffSec < 60) return "just now";
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;
  const diffDay = Math.floor(diffHr / 24);
  return `${diffDay}d ago`;
}

export function relativeTimeFuture(iso: string): string {
  const now = Date.now();
  const then = new Date(iso).getTime();
  const diffMs = then - now;

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

import type { Item } from "./store.ts";

/** Format full details of an item as a multi-line string (for the show command). */
export function formatItemDetail(item: Item): string {
  const lines: string[] = [];
  lines.push(`ID:          ${shortId(item.id)}`);
  lines.push(`Title:       ${item.title}`);
  lines.push(`Status:      ${item.status}`);
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
