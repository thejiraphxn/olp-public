/**
 * Task lifecycle — mirrors backend `domain/entities/Task.ts`.
 * Frontend uses the union directly; no Prisma import.
 */
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

export type TaskBadgeKind = 'queued' | 'working' | 'busy' | 'ready' | 'failed' | 'canceled';

export const TASK_LABELS: Record<TaskStatus, string> = {
  PENDING: 'Queued',
  CLAIMED: 'Starting',
  TRANSCODING: 'Encoding video',
  EXTRACTING_AUDIO: 'Extracting audio',
  UPLOADING_AUDIO: 'Saving audio',
  THUMBNAIL: 'Thumbnail',
  HANDED_OFF: 'Handed to whisper',
  TRANSCRIBING: 'Transcribing',
  SUMMARIZING: 'Generating summary',
  COMPLETED: 'Ready',
  FAILED: 'Failed',
  CANCELED: 'Canceled',
};

export const TASK_BADGE_KIND: Record<TaskStatus, TaskBadgeKind> = {
  PENDING: 'queued',
  CLAIMED: 'queued',
  TRANSCODING: 'working',
  EXTRACTING_AUDIO: 'working',
  UPLOADING_AUDIO: 'working',
  THUMBNAIL: 'working',
  HANDED_OFF: 'busy',
  TRANSCRIBING: 'busy',
  SUMMARIZING: 'busy',
  COMPLETED: 'ready',
  FAILED: 'failed',
  CANCELED: 'canceled',
};

export const TERMINAL_TASK_STATUSES: readonly TaskStatus[] = [
  'COMPLETED',
  'FAILED',
  'CANCELED',
];

export function isTerminalTaskStatus(s: TaskStatus): boolean {
  return (TERMINAL_TASK_STATUSES as readonly string[]).includes(s);
}
