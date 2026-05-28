import { Router } from 'express';
import { CourseRole } from '@prisma/client';
import { prisma } from '../../lib/prisma.js';
import { requireAuth, requireCourseRole } from '../../middleware/auth.js';

export const questionsRouter = Router({ mergeParams: true });

questionsRouter.use(requireAuth);

// Historical questions for a session — used to seed the UI on page load.
// Real-time delivery happens via Socket.io.
questionsRouter.get(
  '/',
  requireCourseRole('courseId', [CourseRole.TEACHER, CourseRole.STUDENT], { allowPublicRead: true }),
  async (req, res, next) => {
    try {
      const rows = await prisma.sessionQuestion.findMany({
        where: { sessionId: req.params.sessionId },
        include: {
          askedBy: { select: { id: true, name: true } },
          answeredBy: { select: { id: true, name: true } },
        },
        orderBy: { createdAt: 'asc' },
        take: 200,
      });
      res.json(
        rows.map((r) => ({
          id: r.id,
          sessionId: r.sessionId,
          askedByUserId: r.askedByUserId,
          askedByName: r.askedBy?.name ?? r.askedGuestName ?? 'Guest',
          text: r.text,
          answeredAt: r.answeredAt?.toISOString() ?? null,
          answeredByUserId: r.answeredByUserId,
          answeredByName: r.answeredBy?.name ?? null,
          answerText: r.answerText,
          createdAt: r.createdAt.toISOString(),
        })),
      );
    } catch (e) {
      next(e);
    }
  },
);

// Also allow REST POST as a fallback (if socket is unavailable). Guests are
// allowed on PUBLIC courses; their ID isn't in the User table so we store
// the guest display name instead.
questionsRouter.post(
  '/',
  requireCourseRole('courseId', [CourseRole.TEACHER, CourseRole.STUDENT], { allowPublicRead: true }),
  async (req, res, next) => {
    try {
      const text = String(req.body?.text ?? '').trim();
      if (!text || text.length > 500)
        return res.status(400).json({ error: 'invalid text' });
      const isGuest = req.isGuest === true;
      const row = await prisma.sessionQuestion.create({
        data: {
          sessionId: req.params.sessionId,
          askedByUserId: isGuest ? undefined : req.userId!,
          askedGuestName: isGuest ? req.guestName ?? 'Guest' : undefined,
          text,
        },
      });
      res.status(201).json(row);
    } catch (e) {
      next(e);
    }
  },
);
