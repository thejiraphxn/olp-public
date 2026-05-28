/**
 * Admin task inspector — replaces the bull-board UI. List, drill-down,
 * retry, cancel. Auth-gated to teachers (any role TEACHER counts; we
 * don't have a global admin yet).
 */
import { Router } from 'express';
import { CourseRole } from '@prisma/client';
import { z } from 'zod';
import { prisma } from '../../lib/prisma.js';
import { requireAuth } from '../../middleware/auth.js';
import { getContainer } from '../../composition.js';
import type { TaskStatus } from '../../domain/entities/Task.js';

export const tasksRouter = Router();

tasksRouter.use(requireAuth);

// Same gate the old admin/queue route used: any user with at least one
// TEACHER membership can see tasks. Tighten later if we add a global
// "site admin" concept.
tasksRouter.use(async (req, res, next) => {
  try {
    const isTeacher = await prisma.courseMember.findFirst({
      where: { userId: req.userId!, role: CourseRole.TEACHER },
      select: { id: true },
    });
    if (!isTeacher) return res.status(403).json({ error: 'teacher only' });
    next();
  } catch (e) {
    next(e);
  }
});

const listSchema = z.object({
  status: z
    .union([z.string(), z.array(z.string())])
    .optional()
    .transform((v) => (Array.isArray(v) ? v : v ? [v] : undefined)),
  recordingId: z.string().optional(),
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
});

tasksRouter.get('/', async (req, res, next) => {
  try {
    const { status, recordingId, cursor, limit } = listSchema.parse(req.query);
    const result = await getContainer(req).useCases.listTasks.execute({
      status: status as TaskStatus[] | undefined,
      recordingId,
      cursor,
      limit,
    });
    res.json(result);
  } catch (e) {
    next(e);
  }
});

tasksRouter.get('/:id', async (req, res, next) => {
  try {
    const task = await getContainer(req).tasks.findById(req.params.id);
    if (!task) return res.status(404).json({ error: 'not found' });
    res.json(task);
  } catch (e) {
    next(e);
  }
});

const retrySchema = z.object({
  transport: z.enum(['pull', 'push']).optional(),
});

tasksRouter.post('/:id/retry', async (req, res, next) => {
  try {
    const { transport } = retrySchema.parse(req.body ?? {});
    await getContainer(req).useCases.retryTask.execute(req.params.id, { transport });
    res.json({ ok: true });
  } catch (e) {
    next(e);
  }
});

tasksRouter.post('/:id/cancel', async (req, res, next) => {
  try {
    const reason = String(req.body?.reason ?? '').slice(0, 500) || undefined;
    await getContainer(req).useCases.cancelTask.execute(req.params.id, reason);
    res.json({ ok: true });
  } catch (e) {
    next(e);
  }
});
