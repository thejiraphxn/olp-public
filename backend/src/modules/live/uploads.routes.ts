import { Router } from 'express';
import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import { CourseRole } from '@prisma/client';
import { requireAuth, requireCourseRole } from '../../middleware/auth.js';
import { presignPut, presignGet } from '../storage/s3.js';
import { prisma } from '../../lib/prisma.js';

export const uploadsRouter = Router({ mergeParams: true });

uploadsRouter.use(requireAuth);

const initSchema = z.object({
  filename: z.string().min(1).max(200),
  mimeType: z.string().min(1).max(100),
  size: z.number().int().min(1).max(25 * 1024 * 1024), // 25 MB cap
});

// Issue a short-lived PUT URL for uploading a chat attachment, then the
// client uses the returned key when sending the message via socket/REST.
uploadsRouter.post(
  '/init',
  // Guests on PUBLIC courses can attach files to chat too — allowPublicRead
  // gates on (course.visibility === PUBLIC) so this isn't a wide-open hole.
  requireCourseRole('courseId', [CourseRole.TEACHER, CourseRole.STUDENT], { allowPublicRead: true }),
  async (req, res, next) => {
    try {
      const { filename, mimeType, size } = initSchema.parse(req.body);
      const safe = filename.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 80);
      const key = `chat/${req.params.sessionId}/${randomUUID()}-${safe}`;
      const url = await presignPut(key, mimeType);
      res.json({ key, url, filename: safe, mimeType, size });
    } catch (e) {
      next(e);
    }
  },
);

// Resolve a temporary GET URL for displaying/downloading a chat attachment.
uploadsRouter.get(
  '/sign',
  requireCourseRole('courseId', [CourseRole.TEACHER, CourseRole.STUDENT], { allowPublicRead: true }),
  async (req, res, next) => {
    try {
      const key = String(req.query.key ?? '');
      if (!key.startsWith(`chat/${req.params.sessionId}/`))
        return res.status(400).json({ error: 'invalid key' });
      const url = await presignGet(key, 60 * 30);
      res.json({ url });
    } catch (e) {
      next(e);
    }
  },
);

// Historical chat messages (with attachment metadata)
uploadsRouter.get(
  '/messages',
  requireCourseRole('courseId', [CourseRole.TEACHER, CourseRole.STUDENT], { allowPublicRead: true }),
  async (req, res, next) => {
    try {
      const msgs = await prisma.sessionChatMessage.findMany({
        where: { sessionId: req.params.sessionId },
        include: { user: { select: { name: true } } },
        orderBy: { createdAt: 'asc' },
        take: 500,
      });
      // Flatten guest fallback for the wire so the client doesn't need to know
      // about the user/guestName split.
      res.json(
        msgs.map((m) => ({
          ...m,
          userName: m.user?.name ?? m.guestName ?? 'Guest',
        })),
      );
    } catch (e) {
      next(e);
    }
  },
);
