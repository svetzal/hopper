export const VERSION = "0.5.0";

export const Status = {
  QUEUED: "queued",
  IN_PROGRESS: "in_progress",
  COMPLETED: "completed",
  CANCELLED: "cancelled",
  SCHEDULED: "scheduled",
} as const;

export type ItemStatus = (typeof Status)[keyof typeof Status];
