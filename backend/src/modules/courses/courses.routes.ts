import { Router } from 'express';
import { z } from 'zod';
import { CourseRole, CourseVisibility } from '@prisma/client';
import { prisma } from '../../lib/prisma.js';
import { requireAuth, requireCourseRole } from '../../middleware/auth.js';
import { pageSchema, toPaginated } from '../../lib/pagination.js';
import { generateJoinCode } from '../../lib/joinCode.js';
import { cleanupRecordingS3, deleteObjects } from '../storage/s3.js';
import { logger } from '../../lib/logger.js';

export const coursesRouter = Router();

coursesRouter.use(requireAuth);

coursesRouter.get('/', async (req, res, next) => {
  try {
    const { page, limit, q } = pageSchema.parse(req.query);
    const baseWhere = { members: { some: { userId: req.userId! } } } as const;
    const where = q
      ? {
          AND: [
            baseWhere,
            {
              OR: [
                { code: { contains: q, mode: 'insensitive' as const } },
                { title: { contains: q, mode: 'insensitive' as const } },
                { description: { contains: q, mode: 'insensitive' as const } },
              ],
            },
          ],
        }
      : baseWhere;

    const [total, courses] = await Promise.all([
      prisma.course.count({ where }),
      prisma.course.findMany({
        where,
        include: {
          _count: { select: { sessions: true, members: true } },
          members: { where: { userId: req.userId! }, select: { role: true } },
        },
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
    ]);

    res.json(
      toPaginated(
        courses.map((c) => ({
          id: c.id,
          code: c.code,
          title: c.title,
          description: c.description,
          coverColor: c.coverColor,
          visibility: c.visibility,
          sessionCount: c._count.sessions,
          memberCount: c._count.members,
          myRole: c.members[0]?.role ?? null,
        })),
        total,
        { page, limit, q },
      ),
    );
  } catch (e) {
    next(e);
  }
});

const createSchema = z.object({
  code: z.string().min(2).max(20),
  title: z.string().min(1).max(120),
  description: z.string().max(500).optional(),
  visibility: z.nativeEnum(CourseVisibility).optional(),
});

const updateSchema = createSchema.partial().extend({
  joinCode: z.string().min(4).max(32).optional(),
});

coursesRouter.post('/', async (req, res, next) => {
  try {
    const body = createSchema.parse(req.body);
    // Retry if unique collision on joinCode
    for (let i = 0; i < 5; i++) {
      const joinCode = generateJoinCode();
      try {
        const course = await prisma.$transaction(async (tx) => {
          const c = await tx.course.create({
            data: {
              ...body,
              joinCode,
              visibility: body.visibility ?? CourseVisibility.PRIVATE,
              ownerId: req.userId!,
            },
          });
          await tx.courseMember.create({
            data: { courseId: c.id, userId: req.userId!, role: CourseRole.TEACHER },
          });
          return c;
        });
        return res.status(201).json(course);
      } catch (e: any) {
        if (e?.code === 'P2002' && e?.meta?.target?.includes?.('joinCode')) continue;
        throw e;
      }
    }
    throw new Error('Failed to allocate a unique join code after 5 tries');
  } catch (e) {
    next(e);
  }
});

// Enroll in a course via its join code. Anyone authenticated can call this.
coursesRouter.post('/join', async (req, res, next) => {
  try {
    const { code } = z
      .object({ code: z.string().min(4).max(32) })
      .parse(req.body);
    const normalized = code.trim().toUpperCase();
    const course = await prisma.course.findUnique({ where: { joinCode: normalized } });
    if (!course) return res.status(404).json({ error: 'Invalid join code' });
    const member = await prisma.courseMember.upsert({
      where: { courseId_userId: { courseId: course.id, userId: req.userId! } },
      update: {}, // keep existing role if already a member
      create: { courseId: course.id, userId: req.userId!, role: CourseRole.STUDENT },
    });
    res.status(201).json({
      courseId: course.id,
      code: course.code,
      title: course.title,
      role: member.role,
      joined: true,
    });
  } catch (e) {
    next(e);
  }
});

// Rotate the join code (teacher only) — useful if it leaked.
coursesRouter.post(
  '/:courseId/rotate-join-code',
  requireCourseRole('courseId', [CourseRole.TEACHER]),
  async (req, res, next) => {
    try {
      for (let i = 0; i < 5; i++) {
        try {
          const c = await prisma.course.update({
            where: { id: req.params.courseId },
            data: { joinCode: generateJoinCode() },
          });
          return res.json({ joinCode: c.joinCode });
        } catch (e: any) {
          if (e?.code === 'P2002' && e?.meta?.target?.includes?.('joinCode')) continue;
          throw e;
        }
      }
      throw new Error('Failed to rotate join code');
    } catch (e) {
      next(e);
    }
  },
);

coursesRouter.get('/:courseId', async (req, res, next) => {
  try {
    const course = await prisma.course.findUnique({
      where: { id: req.params.courseId },
      include: {
        _count: { select: { sessions: true, members: true } },
        members: {
          where: { userId: req.userId! },
          select: { role: true },
        },
        owner: { select: { id: true, name: true, email: true } },
      },
    });
    if (!course) return res.status(404).json({ error: 'not found' });
    const myRole = course.members[0]?.role ?? null;
    // PUBLIC courses: anyone signed in can view — they see as "guest" until enrolled.
    if (!myRole && course.visibility !== CourseVisibility.PUBLIC)
      return res.status(403).json({ error: 'forbidden' });
    const isTeacher = myRole === CourseRole.TEACHER;
    res.json({
      id: course.id,
      code: course.code,
      title: course.title,
      description: course.description,
      coverColor: course.coverColor,
      visibility: course.visibility,
      // Only expose the join code to teachers (source of truth for invites)
      joinCode: isTeacher ? course.joinCode : null,
      owner: course.owner,
      sessionCount: course._count.sessions,
      memberCount: course._count.members,
      myRole,
    });
  } catch (e) {
    next(e);
  }
});

coursesRouter.patch(
  '/:courseId',
  requireCourseRole('courseId', [CourseRole.TEACHER]),
  async (req, res, next) => {
    try {
      const body = updateSchema.parse(req.body);
      const data: any = { ...body };
      if (body.joinCode) data.joinCode = body.joinCode.trim().toUpperCase();
      const c = await prisma.course.update({
        where: { id: req.params.courseId },
        data,
      });
      res.json(c);
    } catch (e: any) {
      if (e?.code === 'P2002' && e?.meta?.target?.includes?.('joinCode')) {
        return res.status(409).json({ error: 'join code already in use' });
      }
      next(e);
    }
  },
);

coursesRouter.delete(
  '/:courseId',
  requireCourseRole('courseId', [CourseRole.TEACHER]),
  async (req, res, next) => {
    try {
      const courseId = req.params.courseId;

      // Gather all S3 keys owned by this course before DB cascade wipes rows.
      // One query for recordings + one for chat attachments is enough — the
      // keys are small and we're in a TEACHER-only destructive path.
      const sessions = await prisma.courseSession.findMany({
        where: { courseId },
        select: {
          id: true,
          recording: {
            select: {
              rawKey: true,
              playbackKey: true,
              audioKey: true,
              thumbnailKey: true,
              s3UploadId: true,
            },
          },
          chats: { select: { attachmentKey: true } },
        },
      });

      // Recordings: cleanupRecordingS3 handles abortMultipart + deleteObjects
      // for raw/playback/audio/thumb in one call.
      await Promise.all(
        sessions
          .map((s) => s.recording)
          .filter((r): r is NonNullable<typeof r> => !!r)
          .map((r) => cleanupRecordingS3(r)),
      );

      // Chat attachments are independent of recordings — collect + bulk delete.
      const chatKeys = sessions.flatMap((s) =>
        s.chats.map((m) => m.attachmentKey).filter((k): k is string => !!k),
      );
      if (chatKeys.length > 0) await deleteObjects(chatKeys);

      await prisma.course.delete({ where: { id: courseId } });
      logger.info(
        {
          courseId,
          sessionCount: sessions.length,
          recordingCount: sessions.filter((s) => s.recording).length,
          chatAttachmentCount: chatKeys.length,
        },
        'course deleted with S3 cleanup',
      );
      res.status(204).end();
    } catch (e) {
      next(e);
    }
  },
);
