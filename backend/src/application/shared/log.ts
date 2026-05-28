import type { TaskLogEntry, TaskLogLevel } from '../../domain/entities/Task.js';

export function makeLogEntry(
  level: TaskLogLevel,
  stage: string,
  message: string,
): TaskLogEntry {
  return {
    ts: new Date().toISOString(),
    level,
    stage,
    message: message.slice(0, 500),
  };
}
