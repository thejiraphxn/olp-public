import { Router } from 'express';
import { z } from 'zod';
import { CourseRole } from '@prisma/client';
import { prisma } from '../../lib/prisma.js';
import { requireAuth, requireCourseRole } from '../../middleware/auth.js';

export const membersRouter = Router({ mergeParams: true });

membersRouter.use(requireAuth);

membersRouter.get(
  '/',
  requireCourseRole('courseId', [CourseRole.TEACHER, CourseRole.STUDENT]),
  async (req, res, next) => {
    try {
      const members = await prisma.courseMember.findMany({
        where: { courseId: req.params.courseId },
        include: { user: { select: { id: true, name: true, email: true } } },
        orderBy: { joinedAt: 'asc' },
      });
      res.json(
        members.map((m) => ({
          userId: m.userId,
          role: m.role,
          joinedAt: m.joinedAt,
          name: m.user.name,
          email: m.user.email,
        })),
      );
    } catch (e) {
      next(e);
    }
  },
);

const inviteSchema = z.object({
  email: z.string().email(),
  role: z.nativeEnum(CourseRole).default(CourseRole.STUDENT),
});

membersRouter.post(
  '/',
  requireCourseRole('courseId', [CourseRole.TEACHER]),
  async (req, res, next) => {
    try {
      const { email, role } = inviteSchema.parse(req.body);
      const user = await prisma.user.findUnique({ where: { email } });
      if (!user) return res.status(404).json({ error: 'user not found' });
      const member = await prisma.courseMember.upsert({
        where: { courseId_userId: { courseId: req.params.courseId, userId: user.id } },
        update: { role },
        create: { courseId: req.params.courseId, userId: user.id, role },
      });
      res.status(201).json(member);
    } catch (e) {
      next(e);
    }
  },
);

membersRouter.patch(
  '/:userId',
  requireCourseRole('courseId', [CourseRole.TEACHER]),
  async (req, res, next) => {
    try {
      const { role } = z.object({ role: z.nativeEnum(CourseRole) }).parse(req.body);
      const member = await prisma.courseMember.update({
        where: {
          courseId_userId: { courseId: req.params.courseId, userId: req.params.userId },
        },
        data: { role },
      });
      res.json(member);
    } catch (e) {
      next(e);
    }
  },
);

membersRouter.delete(
  '/:userId',
  requireCourseRole('courseId', [CourseRole.TEACHER]),
  async (req, res, next) => {
    try {
      await prisma.courseMember.delete({
        where: {
          courseId_userId: { courseId: req.params.courseId, userId: req.params.userId },
        },
      });
      res.status(204).end();
    } catch (e) {
      next(e);
    }
  },
);
