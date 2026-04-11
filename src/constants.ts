export const VERSION = "1.5.0";

export const Status = {
  QUEUED: "queued",
  IN_PROGRESS: "in_progress",
  COMPLETED: "completed",
  CANCELLED: "cancelled",
  SCHEDULED: "scheduled",
  BLOCKED: "blocked",
} as const;

export type ItemStatus = (typeof Status)[keyof typeof Status];
