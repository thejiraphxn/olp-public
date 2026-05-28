import type {
  Task,
  TaskLogEntry,
  TaskStatus,
  TaskType,
} from '../entities/Task.js';

export type CreateTaskInput = {
  type: TaskType;
  recordingId?: string | null;
  payload?: Record<string, unknown> | null;
  maxAttempts?: number;
};

export type ClaimedTask = Task;

export type ListTasksFilter = {
  status?: TaskStatus[];
  recordingId?: string;
  limit?: number;
  cursor?: string;       // task id for keyset pagination
};

export type ListTasksResult = {
  items: Task[];
  nextCursor: string | null;
};

/**
 * Persistence port for Task. The implementation lives in
 * `infrastructure/db/PrismaTaskRepository.ts`.
 *
 * `claimNext` MUST be transactional and use row-level locking
 * (`FOR UPDATE SKIP LOCKED`) so multiple workers can run safely.
 */
export interface TaskRepository {
  create(input: CreateTaskInput): Promise<Task>;

  /**
   * Atomically claim the next runnable task:
   *   1. status = PENDING, OR (lockedUntil < now AND status not terminal)
   *   2. set lockedBy, lockedUntil = now + leaseMs, status = 'CLAIMED', startedAt = now (if first)
   * Returns null when nothing is available.
   */
  claimNext(workerId: string, leaseMs: number): Promise<ClaimedTask | null>;

  /** Refresh `lockedUntil` to keep ownership while running. No-ops if not held. */
  heartbeat(taskId: string, workerId: string, leaseMs: number): Promise<void>;

  /** Move to a new status. Caller appends a log entry separately if useful. */
  updateStatus(taskId: string, status: TaskStatus): Promise<void>;

  appendLog(taskId: string, entry: TaskLogEntry): Promise<void>;

  /** Mark COMPLETED, clear lock + errorMessage, set completedAt. */
  markCompleted(taskId: string): Promise<void>;

  /**
   * Release the lock without changing status. Used when the Node worker
   * has finished its share of the pipeline but ownership now belongs to
   * an external worker (Python whisper-server).
   */
  releaseLock(taskId: string): Promise<void>;

  /**
   * Either:
   *   - increment attempts and return to PENDING (if attempts < maxAttempts), OR
   *   - set FAILED with errorMessage, clear lock.
   * Returns the resulting status so the worker knows what happened.
   */
  recordFailure(taskId: string, errorMessage: string): Promise<TaskStatus>;

  cancel(taskId: string, reason?: string): Promise<void>;

  /**
   * Replace the `payload` JSON column. Used by admin actions that need to
   * carry per-retry hints (e.g. `transport: 'push'`) into the next run.
   */
  updatePayload(taskId: string, payload: Record<string, unknown> | null): Promise<void>;

  findById(id: string): Promise<Task | null>;

  list(filter: ListTasksFilter): Promise<ListTasksResult>;
}
