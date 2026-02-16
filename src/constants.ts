export const VERSION = "0.3.1";

export const Status = {
  QUEUED: "queued",
  IN_PROGRESS: "in_progress",
  COMPLETED: "completed",
  CANCELLED: "cancelled",
} as const;

export type ItemStatus = (typeof Status)[keyof typeof Status];
