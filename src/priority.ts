export type Priority = 'high' | 'normal' | 'low';

const PRIORITY_MAP: Record<string, Priority> = {
  high: 'high',
  h: 'high',
  hi: 'high',
  normal: 'normal',
  n: 'normal',
  low: 'low',
  l: 'low',
  lo: 'low',
};

export function parsePriority(value: string): Priority {
  const normalized = PRIORITY_MAP[value.toLowerCase()];
  if (!normalized) {
    throw new Error(`Invalid priority '${value}'. Use high, normal, or low.`);
  }
  return normalized;
}

export function priorityBadge(priority: Priority | undefined): string {
  if (priority === 'high') return ' [\u{1F534} high]';
  if (priority === 'low') return ' [\u{1F535} low]';
  return '';
}
