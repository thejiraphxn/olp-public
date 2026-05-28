import { Prisma, type PrismaClient, type Task as PrismaTaskRow } from '@prisma/client';
import type {
  ClaimedTask,
  CreateTaskInput,
  ListTasksFilter,
  ListTasksResult,
  TaskRepository,
} from '../../domain/ports/TaskRepository.js';
import type {
  Task,
  TaskLogEntry,
  TaskStatus,
  TaskType,
} from '../../domain/entities/Task.js';

const MAX_LOG_ENTRIES = 200;

function toDomain(row: PrismaTaskRow): Task {
  // Prisma stores JSONB as `unknown`; Task.logs is constrained by domain
  // contract (we only ever write entries through `appendLog`).
  const logs = Array.isArray(row.logs) ? (row.logs as unknown as TaskLogEntry[]) : [];
  return {
    id: row.id,
    type: row.type as TaskType,
    status: row.status as TaskStatus,
    recordingId: row.recordingId,
    payload: (row.payload as Record<string, unknown> | null) ?? null,
    attempts: row.attempts,
    maxAttempts: row.maxAttempts,
    startedAt: row.startedAt,
    completedAt: row.completedAt,
    errorMessage: row.errorMessage,
    logs,
    lockedBy: row.lockedBy,
    lockedUntil: row.lockedUntil,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export class PrismaTaskRepository implements TaskRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async create(input: CreateTaskInput): Promise<Task> {
    const row = await this.prisma.task.create({
      data: {
        type: input.type,
        recordingId: input.recordingId ?? null,
        payload: (input.payload as object | null) ?? undefined,
        maxAttempts: input.maxAttempts ?? 3,
      },
    });
    return toDomain(row);
  }

  /**
   * `FOR UPDATE SKIP LOCKED` is the classic Postgres queue pattern.
   * The CTE selects one runnable task and locks it, then the outer
   * UPDATE atomically marks it CLAIMED. Multiple workers running this
   * concurrently each get a different row (or none).
   *
   * "Runnable" = PENDING, OR a non-terminal status whose lease expired
   * (worker died, lockedUntil in the past).
   */
  async claimNext(workerId: string, leaseMs: number): Promise<ClaimedTask | null> {
    const lockedUntil = new Date(Date.now() + leaseMs);
    // The exclusion list covers two cases:
    //   - terminal: COMPLETED / FAILED / CANCELED — done forever.
    //   - python-owned: HANDED_OFF / TRANSCRIBING / SUMMARIZING — these
    //     are driven by the Python whisper-server which writes to the DB
    //     directly. A Node worker re-claiming them would race with
    //     Python's status updates. If Python crashes mid-run the task
    //     gets stuck; admin retries via /admin/tasks (sets status back
    //     to PENDING which we DO claim).
    const rows = await this.prisma.$queryRawUnsafe<PrismaTaskRow[]>(
      `
      WITH next AS (
        SELECT id FROM "Task"
         WHERE status = 'PENDING'
            OR (
              status NOT IN (
                'COMPLETED', 'FAILED', 'CANCELED',
                'HANDED_OFF', 'TRANSCRIBING', 'SUMMARIZING'
              )
              AND ("lockedUntil" IS NULL OR "lockedUntil" < now())
            )
         ORDER BY "createdAt" ASC
         LIMIT 1
         FOR UPDATE SKIP LOCKED
      )
      UPDATE "Task" t
         SET status = 'CLAIMED',
             "lockedBy" = $1,
             "lockedUntil" = $2,
             "startedAt" = COALESCE(t."startedAt", now()),
             "updatedAt" = now()
        FROM next
       WHERE t.id = next.id
       RETURNING t.*;
      `,
      workerId,
      lockedUntil,
    );
    if (rows.length === 0) return null;
    return toDomain(rows[0]);
  }

  async heartbeat(taskId: string, workerId: string, leaseMs: number): Promise<void> {
    const lockedUntil = new Date(Date.now() + leaseMs);
    await this.prisma.task.updateMany({
      where: { id: taskId, lockedBy: workerId },
      data: { lockedUntil },
    });
  }

  async updateStatus(taskId: string, status: TaskStatus): Promise<void> {
    await this.prisma.task.update({
      where: { id: taskId },
      data: { status },
    });
  }

  async appendLog(taskId: string, entry: TaskLogEntry): Promise<void> {
    // Read-modify-write is acceptable here because only the lock-holder
    // calls this. Multi-writer log races would need jsonb_insert.
    const row = await this.prisma.task.findUnique({
      where: { id: taskId },
      select: { logs: true },
    });
    if (!row) return;
    const existing = Array.isArray(row.logs)
      ? (row.logs as unknown as TaskLogEntry[])
      : [];
    const merged = [...existing, entry];
    const trimmed =
      merged.length > MAX_LOG_ENTRIES
        ? merged.slice(merged.length - MAX_LOG_ENTRIES)
        : merged;
    await this.prisma.task.update({
      where: { id: taskId },
      data: { logs: trimmed as unknown as object },
    });
  }

  async markCompleted(taskId: string): Promise<void> {
    await this.prisma.task.update({
      where: { id: taskId },
      data: {
        status: 'COMPLETED',
        completedAt: new Date(),
        errorMessage: null,
        lockedBy: null,
        lockedUntil: null,
      },
    });
  }

  async releaseLock(taskId: string): Promise<void> {
    await this.prisma.task.update({
      where: { id: taskId },
      data: { lockedBy: null, lockedUntil: null },
    });
  }

  async recordFailure(taskId: string, errorMessage: string): Promise<TaskStatus> {
    return this.prisma.$transaction(async (tx) => {
      const row = await tx.task.findUnique({
        where: { id: taskId },
        select: { attempts: true, maxAttempts: true },
      });
      if (!row) throw new Error('task disappeared');
      const nextAttempts = row.attempts + 1;
      const giveUp = nextAttempts >= row.maxAttempts;
      const next: TaskStatus = giveUp ? 'FAILED' : 'PENDING';
      await tx.task.update({
        where: { id: taskId },
        data: {
          status: next,
          attempts: nextAttempts,
          errorMessage: errorMessage.slice(0, 500),
          lockedBy: null,
          lockedUntil: null,
          completedAt: giveUp ? new Date() : null,
        },
      });
      return next;
    });
  }

  async cancel(taskId: string, reason?: string): Promise<void> {
    await this.prisma.task.update({
      where: { id: taskId },
      data: {
        status: 'CANCELED',
        errorMessage: reason ? reason.slice(0, 500) : null,
        completedAt: new Date(),
        lockedBy: null,
        lockedUntil: null,
      },
    });
  }

  async updatePayload(
    taskId: string,
    payload: Record<string, unknown> | null,
  ): Promise<void> {
    await this.prisma.task.update({
      where: { id: taskId },
      data: {
        payload:
          payload === null ? Prisma.JsonNull : (payload as Prisma.InputJsonValue),
      },
    });
  }

  async findById(id: string): Promise<Task | null> {
    const row = await this.prisma.task.findUnique({ where: { id } });
    return row ? toDomain(row) : null;
  }

  async list(filter: ListTasksFilter): Promise<ListTasksResult> {
    const limit = Math.min(Math.max(filter.limit ?? 50, 1), 200);
    const rows = await this.prisma.task.findMany({
      where: {
        ...(filter.status ? { status: { in: filter.status } } : {}),
        ...(filter.recordingId ? { recordingId: filter.recordingId } : {}),
        ...(filter.cursor ? { id: { lt: filter.cursor } } : {}),
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
    });
    const hasMore = rows.length > limit;
    const items = (hasMore ? rows.slice(0, limit) : rows).map(toDomain);
    return {
      items,
      nextCursor: hasMore ? items[items.length - 1].id : null,
    };
  }
}
