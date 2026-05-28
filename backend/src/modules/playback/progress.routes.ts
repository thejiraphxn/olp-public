import { Router } from 'express';
import { z } from 'zod';
import { RecordingStatus } from '@prisma/client';
import { prisma } from '../../lib/prisma.js';
import { requireAuth } from '../../middleware/auth.js';

export const progressRouter = Router();

progressRouter.use(requireAuth);

const putSchema = z.object({
  sessionId: z.string().cuid(),
  positionSec: z.number().int().min(0),
  completed: z.boolean().optional(),
});

progressRouter.put('/', async (req, res, next) => {
  try {
    const { sessionId, positionSec, completed } = putSchema.parse(req.body);
    // verify the user is a member of the session's course
    const session = await prisma.courseSession.findUnique({
      where: { id: sessionId },
      select: { id: true, courseId: true },
    });
    if (!session) return res.status(404).json({ error: 'session not found' });
    const member = await prisma.courseMember.findUnique({
      where: { courseId_userId: { courseId: session.courseId, userId: req.userId! } },
    });
    if (!member) return res.status(403).json({ error: 'forbidden' });

    const row = await prisma.sessionProgress.upsert({
      where: { userId_sessionId: { userId: req.userId!, sessionId } },
      update: { positionSec, completed: completed ?? undefined },
      create: { userId: req.userId!, sessionId, positionSec, completed: !!completed },
    });
    res.json(row);
  } catch (e) {
    next(e);
  }
});

progressRouter.get('/continue', async (req, res, next) => {
  try {
    const rows = await prisma.sessionProgress.findMany({
      where: { userId: req.userId!, completed: false },
      orderBy: { updatedAt: 'desc' },
      take: 6,
      include: {
        session: {
          include: {
            course: { select: { id: true, code: true, title: true } },
            recording: { select: { durationSec: true, thumbnailKey: true, status: true } },
          },
        },
      },
    });
    res.json(
      rows.map((r) => ({
        sessionId: r.sessionId,
        courseId: r.session.courseId,
        title: r.session.title,
        positionSec: r.positionSec,
        durationSec: r.session.recording?.durationSec ?? null,
        status: r.session.recording?.status ?? RecordingStatus.PENDING,
        course: r.session.course,
        updatedAt: r.updatedAt,
      })),
    );
  } catch (e) {
    next(e);
  }
});
