import type { TaskRepository } from '../../domain/ports/TaskRepository.js';
import { makeLogEntry } from '../shared/log.js';
import { isTerminal } from '../../domain/entities/Task.js';

export type RetryOptions = {
  /**
   * Override the whisper handoff transport for the next run.
   * 'push' = Node uploads the mp3 in the request body (admin escape hatch
   *          for when MinIO is unreachable from whisper-server).
   * 'pull' = whisper-server fetches mp3 from S3 itself (default behaviour;
   *          passing this clears any previous push override).
   * Omit to leave whatever's already in the payload alone.
   */
  transport?: 'pull' | 'push';
};

/**
 * Admin action: re-arm a finished or failed task so the worker picks
 * it up again. Resets attempts, clears errorMessage, sets PENDING.
 */
export class RetryTask {
  constructor(private readonly tasks: TaskRepository) {}

  async execute(taskId: string, opts: RetryOptions = {}): Promise<void> {
    const task = await this.tasks.findById(taskId);
    if (!task) throw new Error('task not found');
    if (!isTerminal(task.status) && task.status !== 'CLAIMED') {
      throw new Error(`task is currently ${task.status} — cannot retry`);
    }

    if (opts.transport) {
      const merged = { ...(task.payload ?? {}), transport: opts.transport };
      await this.tasks.updatePayload(taskId, merged);
    }

    const note = opts.transport
      ? `manually retried (transport=${opts.transport})`
      : 'manually retried';
    await this.tasks.appendLog(taskId, makeLogEntry('info', 'admin', note));
    await this.tasks.updateStatus(taskId, 'PENDING');
  }
}
