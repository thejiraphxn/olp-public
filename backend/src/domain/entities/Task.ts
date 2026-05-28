/**
 * Task — a unit of background work persisted in Postgres.
 *
 * Lives in the domain layer: plain TS, no framework deps. Adapters in
 * `infrastructure/db/` translate to/from Prisma rows.
 */

export type TaskType = 'RECORDING_PIPELINE';

export type TaskStatus =
  | 'PENDING'
  | 'CLAIMED'
  | 'TRANSCODING'
  | 'EXTRACTING_AUDIO'
  | 'UPLOADING_AUDIO'
  | 'THUMBNAIL'
  | 'HANDED_OFF'
  | 'TRANSCRIBING'
  | 'SUMMARIZING'
  | 'COMPLETED'
  | 'FAILED'
  | 'CANCELED';

export type TaskLogLevel = 'info' | 'warn' | 'error';

export type TaskLogEntry = {
  ts: string;          // ISO timestamp
  level: TaskLogLevel;
  stage: string;       // free-form, e.g. 'transcode' / 'whisper-handoff'
  message: string;
};

export type Task = {
  id: string;
  type: TaskType;
  status: TaskStatus;
  recordingId: string | null;
  payload: Record<string, unknown> | null;
  attempts: number;
  maxAttempts: number;
  startedAt: Date | null;
  completedAt: Date | null;
  errorMessage: string | null;
  logs: TaskLogEntry[];
  lockedBy: string | null;
  lockedUntil: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

export const TERMINAL_STATUSES: readonly TaskStatus[] = [
  'COMPLETED',
  'FAILED',
  'CANCELED',
] as const;

export function isTerminal(status: TaskStatus): boolean {
  return (TERMINAL_STATUSES as readonly TaskStatus[]).includes(status);
}
