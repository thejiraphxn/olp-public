import { Router } from 'express';
import { z } from 'zod';
import { CourseRole, SessionStatus } from '@prisma/client';
import { prisma } from '../../lib/prisma.js';
import { requireAuth, requireCourseRole } from '../../middleware/auth.js';
import { pageSchema, toPaginated } from '../../lib/pagination.js';
import { cleanupRecordingS3, deleteObjects } from '../storage/s3.js';
import { logger } from '../../lib/logger.js';

export const sessionsRouter = Router({ mergeParams: true });

sessionsRouter.use(requireAuth);

const listSchema = pageSchema.extend({
  status: z.nativeEnum(SessionStatus).optional(),
});

sessionsRouter.get(
  '/',
  requireCourseRole('courseId', [CourseRole.TEACHER, CourseRole.STUDENT], { allowPublicRead: true }),
  async (req, res, next) => {
    try {
      const { page, limit, q, status } = listSchema.parse(req.query);
      const where: any = { courseId: req.params.courseId };
      if (status) where.status = status;
      if (q)
        where.OR = [
          { title: { contains: q, mode: 'insensitive' } },
          { description: { contains: q, mode: 'insensitive' } },
        ];

      const [total, sessions] = await Promise.all([
        prisma.courseSession.count({ where }),
        prisma.courseSession.findMany({
          where,
          include: { recording: true },
          orderBy: { scheduledAt: 'asc' },
          skip: (page - 1) * limit,
          take: limit,
        }),
      ]);
      // Hide raw access codes from non-teachers; they only need to know the
      // gate exists so the UI can prompt for the code.
      const isTeacher =
        !!req.userId &&
        !req.isGuest &&
        !!(await prisma.courseMember
          .findUnique({
            where: {
              courseId_userId: { courseId: req.params.courseId, userId: req.userId },
            },
            select: { role: true },
          })
          .then((m) => m?.role === CourseRole.TEACHER));
      const items = sessions.map((s) => {
        const { accessCode, ...rest } = s;
        return {
          ...rest,
          requiresAccessCode: !!accessCode,
          accessCode: isTeacher ? accessCode : undefined,
        };
      });
      res.json(toPaginated(items, total, { page, limit, q }));
    } catch (e) {
      next(e);
    }
  },
);

// Six-digit numeric access code. Null/empty string = clear the code (open
// access). Anything else must match exactly six digits.
const accessCodeSchema = z
  .string()
  .regex(/^\d{6}$/, 'access code must be exactly 6 digits')
  .nullable()
  .optional();

const createSchema = z.object({
  title: z.string().min(1).max(200),
  description: z.string().max(2000).optional(),
  scheduledAt: z.string().datetime().optional(),
  accessCode: accessCodeSchema,
});

sessionsRouter.post(
  '/',
  requireCourseRole('courseId', [CourseRole.TEACHER]),
  async (req, res, next) => {
    try {
      const body = createSchema.parse(req.body);
      const session = await prisma.courseSession.create({
        data: {
          courseId: req.params.courseId,
          title: body.title,
          description: body.description,
          scheduledAt: body.scheduledAt ? new Date(body.scheduledAt) : null,
          status: body.scheduledAt ? SessionStatus.SCHEDULED : SessionStatus.DRAFT,
          accessCode: body.accessCode ?? null,
        },
      });
      res.status(201).json(session);
    } catch (e) {
      next(e);
    }
  },
);

sessionsRouter.get(
  '/:sessionId',
  requireCourseRole('courseId', [CourseRole.TEACHER, CourseRole.STUDENT], { allowPublicRead: true }),
  async (req, res, next) => {
    try {
      const session = await prisma.courseSession.findUnique({
        where: { id: req.params.sessionId },
        include: { recording: true },
      });
      if (!session || session.courseId !== req.params.courseId)
        return res.status(404).json({ error: 'not found' });
      // Only teachers should see the raw access code; everyone else just
      // gets a boolean to know whether the gate is active.
      const isTeacher =
        !!req.userId &&
        !req.isGuest &&
        !!(await prisma.courseMember.findUnique({
          where: {
            courseId_userId: { courseId: session.courseId, userId: req.userId },
          },
          select: { role: true },
        }).then((m) => m?.role === CourseRole.TEACHER));
      const { accessCode, ...rest } = session;
      res.json({
        ...rest,
        requiresAccessCode: !!accessCode,
        accessCode: isTeacher ? accessCode : undefined,
      });
    } catch (e) {
      next(e);
    }
  },
);

sessionsRouter.patch(
  '/:sessionId',
  requireCourseRole('courseId', [CourseRole.TEACHER]),
  async (req, res, next) => {
    try {
      const body = createSchema.partial().parse(req.body);
      const session = await prisma.courseSession.update({
        where: { id: req.params.sessionId },
        data: {
          ...body,
          scheduledAt: body.scheduledAt ? new Date(body.scheduledAt) : undefined,
        },
      });
      res.json(session);
    } catch (e) {
      next(e);
    }
  },
);

sessionsRouter.delete(
  '/:sessionId',
  requireCourseRole('courseId', [CourseRole.TEACHER]),
  async (req, res, next) => {
    try {
      const sessionId = req.params.sessionId;

      // Pull S3 references before the cascade deletes them — same pattern as
      // course delete. Recording + chat attachments both leak otherwise.
      const session = await prisma.courseSession.findUnique({
        where: { id: sessionId },
        select: {
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
      if (!session) return res.status(404).json({ error: 'not found' });

      await cleanupRecordingS3(session.recording);
      const chatKeys = session.chats
        .map((m) => m.attachmentKey)
        .filter((k): k is string => !!k);
      if (chatKeys.length > 0) await deleteObjects(chatKeys);

      await prisma.courseSession.delete({ where: { id: sessionId } });
      logger.info(
        { sessionId, hadRecording: !!session.recording, chatAttachmentCount: chatKeys.length },
        'session deleted with S3 cleanup',
      );
      res.status(204).end();
    } catch (e) {
      next(e);
    }
  },
);

// Anyone with course-read access can submit a code attempt. Open to guests
// too via allowPublicRead. Returns 200 ok on match, 401 on miss. After a
// successful match the client stores the code in sessionStorage and sends
// it as `X-Session-Code` on subsequent calls + in socket auth.
sessionsRouter.post(
  '/:sessionId/verify-code',
  requireCourseRole('courseId', [CourseRole.TEACHER, CourseRole.STUDENT], {
    allowPublicRead: true,
  }),
  async (req, res, next) => {
    try {
      const code = String(req.body?.code ?? '').trim();
      const session = await prisma.courseSession.findUnique({
        where: { id: req.params.sessionId },
        select: { id: true, courseId: true, accessCode: true },
      });
      if (!session || session.courseId !== req.params.courseId)
        return res.status(404).json({ error: 'not found' });
      // No code set → anyone can pass (returns ok so client can stop asking).
      if (!session.accessCode) return res.json({ ok: true, gated: false });
      if (code === session.accessCode) return res.json({ ok: true, gated: true });
      res.status(401).json({ ok: false, error: 'incorrect code' });
    } catch (e) {
      next(e);
    }
  },
);

// Attendance report — teacher-only. Aggregates every stint a user spent in
// the live room, sums to totalSeconds, and includes raw stints for detail.
sessionsRouter.get(
  '/:sessionId/attendance',
  requireCourseRole('courseId', [CourseRole.TEACHER]),
  async (req, res, next) => {
    try {
      const stints = await prisma.sessionAttendance.findMany({
        where: { sessionId: req.params.sessionId },
        orderBy: { joinedAt: 'asc' },
        include: {
          user: { select: { id: true, name: true, email: true } },
        },
      });

      // Also surface enrolled students who never showed up, so the teacher
      // sees a full roster not just "who connected".
      const members = await prisma.courseMember.findMany({
        where: { courseId: req.params.courseId },
        include: { user: { select: { id: true, name: true, email: true } } },
      });

      const now = Date.now();
      type Row = {
        userId: string;            // synthetic 'guest:<name>' for guests
        userName: string;
        email: string;             // empty string for guests
        role: CourseRole;
        isGuest: boolean;
        totalSeconds: number;
        stintCount: number;
        firstSeenAt: string | null;
        lastSeenAt: string | null;
        stints: { joinedAt: string; leftAt: string | null; seconds: number }[];
      };
      const byUser = new Map<string, Row>();
      for (const m of members) {
        byUser.set(m.userId, {
          userId: m.userId,
          userName: m.user.name,
          email: m.user.email,
          role: m.role,
          isGuest: false,
          totalSeconds: 0,
          stintCount: 0,
          firstSeenAt: null,
          lastSeenAt: null,
          stints: [],
        });
      }
      for (const s of stints) {
        // Group guests by their snapshot name (one row per name across
        // multiple stints). Logged-in users group by userId as before.
        const isGuestRow = !s.userId;
        const groupKey = isGuestRow
          ? `guest:${s.guestName ?? 'Guest'}`
          : s.userId!;
        let row = byUser.get(groupKey);
        if (!row) {
          row = {
            userId: groupKey,
            userName: isGuestRow
              ? s.guestName ?? 'Guest'
              : s.user?.name ?? 'unknown',
            email: isGuestRow ? '' : s.user?.email ?? '',
            role: CourseRole.STUDENT,
            isGuest: isGuestRow,
            totalSeconds: 0,
            stintCount: 0,
            firstSeenAt: null,
            lastSeenAt: null,
            stints: [],
          };
          byUser.set(groupKey, row);
        }
        const endMs = s.leftAt ? s.leftAt.getTime() : now; // open stint → live now
        const startMs = s.joinedAt.getTime();
        const seconds = Math.max(0, Math.round((endMs - startMs) / 1000));
        row.stints.push({
          joinedAt: s.joinedAt.toISOString(),
          leftAt: s.leftAt ? s.leftAt.toISOString() : null,
          seconds,
        });
        row.totalSeconds += seconds;
        row.stintCount += 1;
        if (!row.firstSeenAt || startMs < new Date(row.firstSeenAt).getTime()) {
          row.firstSeenAt = s.joinedAt.toISOString();
        }
        const endIso = s.leftAt ? s.leftAt.toISOString() : new Date(endMs).toISOString();
        if (!row.lastSeenAt || endMs > new Date(row.lastSeenAt).getTime()) {
          row.lastSeenAt = endIso;
        }
      }
      // Sort: attended first (descending by time), no-shows last by name.
      const rows = Array.from(byUser.values()).sort((a, b) => {
        if (a.totalSeconds !== b.totalSeconds) return b.totalSeconds - a.totalSeconds;
        return a.userName.localeCompare(b.userName);
      });
      res.json({ attendance: rows });
    } catch (e) {
      next(e);
    }
  },
);
