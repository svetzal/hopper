export const VERSION = "4.1.2";

export const Status = {
  QUEUED: "queued",
  IN_PROGRESS: "in_progress",
  COMPLETED: "completed",
  FAILED: "failed",
  CANCELLED: "cancelled",
  SCHEDULED: "scheduled",
  BLOCKED: "blocked",
} as const;

export type ItemStatus = (typeof Status)[keyof typeof Status];

export const TaskType = {
  INVESTIGATION: "investigation",
  ENGINEERING: "engineering",
  TASK: "task",
} as const;

export type TaskType = (typeof TaskType)[keyof typeof TaskType];

export const TASK_TYPES: readonly TaskType[] = [
  TaskType.INVESTIGATION,
  TaskType.ENGINEERING,
  TaskType.TASK,
] as const;

export function isTaskType(value: string): value is TaskType {
  return (TASK_TYPES as readonly string[]).includes(value);
}
