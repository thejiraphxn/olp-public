import os from 'node:os';
import crypto from 'node:crypto';
import type { TaskRepository } from '../../domain/ports/TaskRepository.js';
import type { Task } from '../../domain/entities/Task.js';
import { logger } from '../../lib/logger.js';
import { makeLogEntry } from '../../application/shared/log.js';
import type { TaskHandlerRegistry } from './TaskHandler.js';

export type TaskWorkerOptions = {
  pollIntervalMs?: number;   // how often to poll for new work (default 2000)
  leaseMs?: number;          // claim lease length (default 60_000)
  heartbeatMs?: number;      // refresh interval (default 20_000 — 1/3 of lease)
};

/**
 * Postgres-backed worker. Replaces BullMQ.
 *
 *   1. Poll: TaskRepository.claimNext (FOR UPDATE SKIP LOCKED)
 *   2. Run:  dispatch by task.type to a handler
 *   3. Done: markCompleted on success, recordFailure on throw
 *   4. While running, heartbeat refreshes the lease so other workers
 *      don't preempt. If we crash mid-run, the lease expires and the
 *      next worker picks up where we left off (handlers are idempotent).
 */
export class TaskWorker {
  private readonly workerId: string;
  private readonly pollIntervalMs: number;
  private readonly leaseMs: number;
  private readonly heartbeatMs: number;
  private polling = false;
  private currentTaskId: string | null = null;
  private pollTimer: NodeJS.Timeout | null = null;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private stopping = false;

  constructor(
    private readonly tasks: TaskRepository,
    private readonly handlers: TaskHandlerRegistry,
    opts: TaskWorkerOptions = {},
  ) {
    this.pollIntervalMs = opts.pollIntervalMs ?? 2000;
    this.leaseMs = opts.leaseMs ?? 60_000;
    this.heartbeatMs = opts.heartbeatMs ?? Math.floor(this.leaseMs / 3);

    const suffix = crypto.randomBytes(3).toString('hex');
    this.workerId = `${os.hostname()}:${process.pid}:${suffix}`;
  }

  start(): void {
    logger.info(
      { workerId: this.workerId, leaseMs: this.leaseMs },
      'task worker starting',
    );
    this.scheduleNextPoll(0);
  }

  async stop(): Promise<void> {
    this.stopping = true;
    if (this.pollTimer) clearTimeout(this.pollTimer);
    this.pollTimer = null;
    // Wait for the in-flight task to finish naturally — don't yank the
    // lease, that would force the next worker to redo work.
    if (this.currentTaskId) {
      logger.info(
        { taskId: this.currentTaskId },
        'waiting for in-flight task to finish before exit',
      );
      // tick until current finishes (tickCount safety: 5 minutes max)
      for (let i = 0; i < 300 && this.currentTaskId; i++) {
        await new Promise((r) => setTimeout(r, 1000));
      }
    }
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = null;
    logger.info({ workerId: this.workerId }, 'task worker stopped');
  }

  private scheduleNextPoll(delayMs: number): void {
    if (this.stopping) return;
    this.pollTimer = setTimeout(() => {
      void this.tick();
    }, delayMs);
  }

  private async tick(): Promise<void> {
    if (this.stopping || this.polling) return;
    this.polling = true;
    try {
      const task = await this.tasks.claimNext(this.workerId, this.leaseMs);
      if (!task) {
        return; // nothing to do
      }
      this.currentTaskId = task.id;
      logger.info(
        { taskId: task.id, type: task.type, attempts: task.attempts },
        'claimed task',
      );
      this.startHeartbeat(task.id);
      try {
        // Handler is responsible for finalization — it must call
        // markCompleted, or set status=HANDED_OFF + releaseLock when
        // ownership passes to an external worker (Python whisper-server).
        // The worker only steps in on exceptions to record the failure.
        await this.runHandler(task);
        logger.info({ taskId: task.id }, 'task handler returned');
      } catch (err: unknown) {
        const msg = String((err as Error)?.message ?? err);
        await this.tasks.appendLog(
          task.id,
          makeLogEntry('error', 'worker', msg),
        );
        const newStatus = await this.tasks.recordFailure(task.id, msg);
        logger.error(
          { taskId: task.id, err: msg, newStatus },
          'task failed',
        );
      } finally {
        this.stopHeartbeat();
        this.currentTaskId = null;
      }
    } catch (err: unknown) {
      // claim itself failed — just log and back off briefly
      logger.error(
        { err: String((err as Error)?.message ?? err) },
        'task claim failed',
      );
    } finally {
      this.polling = false;
      this.scheduleNextPoll(this.pollIntervalMs);
    }
  }

  private async runHandler(task: Task): Promise<void> {
    const handler = this.handlers[task.type];
    if (!handler) {
      throw new Error(`no handler registered for task type "${task.type}"`);
    }
    await handler.execute(task);
  }

  private startHeartbeat(taskId: string): void {
    this.heartbeatTimer = setInterval(() => {
      void this.tasks.heartbeat(taskId, this.workerId, this.leaseMs).catch((e) => {
        logger.warn(
          { taskId, err: String((e as Error)?.message ?? e) },
          'heartbeat failed',
        );
      });
    }, this.heartbeatMs);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = null;
  }
}
