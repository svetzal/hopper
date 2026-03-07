const UNIT_MS: Record<string, number> = {
  s: 1000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
  w: 604_800_000,
};

export function parseDuration(input: string): number {
  const lower = input.trim().toLowerCase();
  const pattern = /^(\d+(?:\.\d+)?[smhdw])+$/;
  if (!pattern.test(lower)) {
    throw new Error(`Cannot parse duration: "${input}"`);
  }

  let totalMs = 0;
  const parts = lower.matchAll(/(\d+(?:\.\d+)?)([smhdw])/g);
  for (const match of parts) {
    const value = parseFloat(match[1]!);
    const unit = match[2]!;
    totalMs += value * UNIT_MS[unit]!;
  }

  if (totalMs === 0) {
    throw new Error(`Cannot parse duration: "${input}"`);
  }
  return totalMs;
}

function parseRelativeDuration(input: string): Date | null {
  const lower = input.toLowerCase();
  const pattern = /^(\d+(?:\.\d+)?[smhdw])+$/;
  if (!pattern.test(lower)) return null;

  let totalMs = 0;
  const parts = lower.matchAll(/(\d+(?:\.\d+)?)([smhdw])/g);
  for (const match of parts) {
    const value = parseFloat(match[1]!);
    const unit = match[2]!;
    totalMs += value * UNIT_MS[unit]!;
  }

  if (totalMs === 0) return null;
  return new Date(Date.now() + totalMs);
}

function parseAbsoluteTime(input: string): Date | null {
  // "tomorrow" with optional time
  const tomorrowMatch = input.match(/^tomorrow(?:\s+(\d{1,2}(?::\d{2})?(?:am|pm)?))?$/i);
  if (tomorrowMatch) {
    const d = new Date();
    d.setDate(d.getDate() + 1);
    if (tomorrowMatch[1]) {
      applyTimeOfDay(d, tomorrowMatch[1]);
    } else {
      d.setHours(0, 0, 0, 0);
    }
    return d;
  }

  // Time only: "14:00" or "2:00pm"
  const timeOnly = input.match(/^(\d{1,2}):(\d{2})\s*(am|pm)?$/i);
  if (timeOnly) {
    const d = new Date();
    applyTimeOfDay(d, input);
    if (d.getTime() <= Date.now()) {
      d.setDate(d.getDate() + 1);
    }
    return d;
  }

  // Hour with am/pm but no colon: "2pm", "9am"
  const hourAmPm = input.match(/^(\d{1,2})(am|pm)$/i);
  if (hourAmPm) {
    const d = new Date();
    applyTimeOfDay(d, input);
    if (d.getTime() <= Date.now()) {
      d.setDate(d.getDate() + 1);
    }
    return d;
  }

  // ISO date with optional time: "2026-03-08", "2026-03-08T14:00", "2026-03-08T14:00:00Z"
  const isoMatch = input.match(/^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2})?(Z|[+-]\d{2}:?\d{2})?)?$/);
  if (isoMatch) {
    let d: Date;
    if (input.length === 10) {
      // Date only — treat as midnight local time
      const [year, month, day] = input.split("-").map(Number);
      d = new Date(year!, month! - 1, day!);
    } else if (input.endsWith("Z") || /[+-]\d{2}:?\d{2}$/.test(input)) {
      d = new Date(input);
    } else {
      // ISO without timezone — treat as local
      d = new Date(input);
    }
    return d;
  }

  return null;
}

function applyTimeOfDay(d: Date, timeStr: string): void {
  const match = timeStr.match(/^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/i);
  if (!match) return;

  let hours = parseInt(match[1]!, 10);
  const minutes = match[2] ? parseInt(match[2], 10) : 0;
  const meridiem = match[3]?.toLowerCase();

  if (meridiem === "pm" && hours !== 12) hours += 12;
  if (meridiem === "am" && hours === 12) hours = 0;

  d.setHours(hours, minutes, 0, 0);
}

export function parseTimeSpec(input: string): Date {
  const trimmed = input.trim();
  if (!trimmed) {
    throw new Error("Empty time specification");
  }

  const relative = parseRelativeDuration(trimmed);
  if (relative) return relative;

  const absolute = parseAbsoluteTime(trimmed);
  if (absolute) {
    if (absolute.getTime() <= Date.now()) {
      throw new Error(`Time is in the past: ${trimmed}`);
    }
    return absolute;
  }

  throw new Error(`Cannot parse time specification: "${trimmed}"`);
}
