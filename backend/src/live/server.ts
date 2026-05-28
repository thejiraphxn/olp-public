import type { Server as HttpServer } from 'node:http';
import jwt from 'jsonwebtoken';
import { Server as IOServer } from 'socket.io';
import { CourseRole, CourseVisibility } from '@prisma/client';
import { config } from '../config.js';
import { logger } from '../lib/logger.js';
import { prisma } from '../lib/prisma.js';
import type {
  ClientToServerEvents,
  Participant,
  Question,
  ChatMessage,
  ServerToClientEvents,
} from './types.js';

type SocketData = {
  userId: string;
  name: string;
  // True when this socket was authenticated via a guest JWT. Guest userIds
  // do NOT exist in the User table — never use them for FK columns.
  isGuest: boolean;
  // Course the guest token was scoped to (only set for guests).
  guestCourseId?: string;
  joinedSessionId?: string;
  // ID of the open SessionAttendance row for the current room, if any. Set
  // on room:join, cleared + closed (leftAt written) on room:leave / disconnect.
  attendanceId?: string;
  hasHandRaised: boolean;
  isPublishing: boolean;
  isMicOn: boolean;
  isCamOn: boolean;
};

function roomKey(sessionId: string) {
  return `session:${sessionId}`;
}

function isTeacher(role: string): role is typeof CourseRole.TEACHER {
  return role === CourseRole.TEACHER;
}

// Close any attendance rows left open from a previous process (crash /
// restart). We can't know the real leftAt, so we stamp it to joinedAt —
// producing a zero-duration stint. Undercounting on crash is safer than
// inflating attendance with hours of dead time.
async function recoverOpenAttendance() {
  try {
    const result: bigint | number = await prisma.$executeRaw`
      UPDATE "SessionAttendance" SET "leftAt" = "joinedAt" WHERE "leftAt" IS NULL
    `;
    const count = typeof result === 'bigint' ? Number(result) : result;
    if (count > 0) logger.warn({ count }, 'closed orphan attendance rows from previous boot');
  } catch (err) {
    logger.warn({ err }, 'attendance recovery failed');
  }
}

export function attachLiveServer(http: HttpServer) {
  void recoverOpenAttendance();

  // Match the HTTP CORS policy — support single / list / wildcard.
  const raw = config.corsOrigin.trim();
  const allowAll = raw === '*';
  const list = raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const io = new IOServer<
    ClientToServerEvents,
    ServerToClientEvents,
    Record<string, never>,
    SocketData
  >(http, {
    cors: {
      origin: (origin, cb) => {
        if (!origin) return cb(null, true);
        if (allowAll) return cb(null, origin);
        if (list.includes(origin)) return cb(null, origin);
        return cb(new Error('cors'), false);
      },
      credentials: true,
    },
    pingInterval: 20_000,
    pingTimeout: 30_000,
  });

  // Auth: prefer handshake auth.token (set by browser from sessionStorage for
  // backward-compat); fall back to the `olp_token` httpOnly cookie sent with
  // the socket.io handshake — this is the norm for same-origin proxy setups.
  io.use(async (socket, next) => {
    try {
      const fromAuth = (socket.handshake.auth as any)?.token as string | undefined;
      const rawCookie = socket.handshake.headers.cookie ?? '';
      const fromCookie = rawCookie
        .split(';')
        .map((s) => s.trim())
        .find((s) => s.startsWith('olp_token='))
        ?.split('=')[1];
      const raw = fromAuth || fromCookie;
      if (!raw) return next(new Error('no-token'));
      const payload = jwt.verify(raw, config.jwtSecret) as {
        sub: string;
        guest?: boolean;
        name?: string;
        courseId?: string;
      };
      if (payload.guest) {
        // No DB lookup — guest identity lives entirely in the JWT.
        socket.data.userId = payload.sub;
        socket.data.name = payload.name ?? 'Guest';
        socket.data.isGuest = true;
        socket.data.guestCourseId = payload.courseId;
      } else {
        const user = await prisma.user.findUnique({ where: { id: payload.sub } });
        if (!user) return next(new Error('invalid-user'));
        socket.data.userId = user.id;
        socket.data.name = user.name;
        socket.data.isGuest = false;
      }
      socket.data.hasHandRaised = false;
      socket.data.isPublishing = false;
      socket.data.isMicOn = false;
      socket.data.isCamOn = false;
      next();
    } catch (e: any) {
      next(new Error(e?.message ?? 'auth-failed'));
    }
  });

  async function getMembership(
    userId: string,
    sessionId: string,
    opts: { isGuest?: boolean; guestCourseId?: string } = {},
  ) {
    const session = await prisma.courseSession.findUnique({
      where: { id: sessionId },
      select: { courseId: true, course: { select: { visibility: true } } },
    });
    if (!session) return null;
    if (opts.isGuest) {
      // Guests can only enter the course their token was scoped to AND only
      // when that course is PUBLIC. Synthetic STUDENT membership — never
      // hits courseMember table because the guest userId has no User row.
      if (opts.guestCourseId && opts.guestCourseId !== session.courseId) return null;
      if (session.course.visibility !== CourseVisibility.PUBLIC) return null;
      return { role: CourseRole.STUDENT } as { role: CourseRole };
    }
    return prisma.courseMember.findUnique({
      where: { courseId_userId: { courseId: session.courseId, userId } },
    });
  }

  async function closeAttendance(attendanceId: string | undefined) {
    if (!attendanceId) return;
    try {
      await prisma.sessionAttendance.update({
        where: { id: attendanceId },
        data: { leftAt: new Date() },
      });
    } catch (err) {
      logger.warn({ err, attendanceId }, 'failed to close attendance row');
    }
  }

  async function currentParticipants(sessionId: string): Promise<Participant[]> {
    const sockets = await io.in(roomKey(sessionId)).fetchSockets();
    const out: Participant[] = [];
    for (const s of sockets) {
      const member = await getMembership(s.data.userId, sessionId, {
        isGuest: s.data.isGuest,
        guestCourseId: s.data.guestCourseId,
      });
      if (!member) continue;
      out.push({
        socketId: s.id,
        userId: s.data.userId,
        name: s.data.name,
        role: member.role,
        hasHandRaised: s.data.hasHandRaised,
        isPublishing: s.data.isPublishing,
        isMicOn: s.data.isMicOn,
        isCamOn: s.data.isCamOn,
      });
    }
    return out;
  }

  io.on('connection', (socket) => {
    logger.info({ userId: socket.data.userId }, 'socket connected');

    socket.on('room:join', async (sessionId, ack) => {
      const member = await getMembership(socket.data.userId, sessionId, { isGuest: socket.data.isGuest, guestCourseId: socket.data.guestCourseId });
      if (!member) {
        ack({ ok: false, error: 'not a member' });
        return;
      }
      // Optional 6-digit access code on the session. Everyone — including
      // the teacher who set it — must supply it via socket handshake
      // auth.sessionCode. Plaintext compare on purpose (soft gate, see
      // lib/sessionGate.ts). The teacher can read the raw value off the
      // session detail response so this is a "type to confirm" step.
      const sessRow = await prisma.courseSession.findUnique({
        where: { id: sessionId },
        select: { accessCode: true },
      });
      if (sessRow?.accessCode) {
        const supplied = (socket.handshake.auth as any)?.sessionCode as string | undefined;
        if (!supplied || supplied !== sessRow.accessCode) {
          ack({ ok: false, error: 'session access code required' });
          return;
        }
      }
      if (socket.data.joinedSessionId && socket.data.joinedSessionId !== sessionId) {
        socket.leave(roomKey(socket.data.joinedSessionId));
        // The user is switching sessions — close the previous attendance row
        // before opening a new one so the old stint has a real leftAt.
        await closeAttendance(socket.data.attendanceId);
        socket.data.attendanceId = undefined;
      }
      socket.data.joinedSessionId = sessionId;
      socket.data.hasHandRaised = false;
      socket.data.isPublishing = isTeacher(member.role);
      // Teacher starts with mic on (the screen-recording pipeline captures
      // mic too); camera is opt-in via the webcam toggle. Students default
      // to off — they flip on after the hand-raise is accepted.
      socket.data.isMicOn = isTeacher(member.role);
      socket.data.isCamOn = false;
      socket.join(roomKey(sessionId));

      // Open a new attendance row. Guests get userId=null + a guestName
      // snapshot from their JWT — the schema allows this (FK is optional)
      // so anonymous viewers on PUBLIC courses still appear in the report.
      try {
        const row = await prisma.sessionAttendance.create({
          data: socket.data.isGuest
            ? { sessionId, userId: null, guestName: socket.data.name }
            : { sessionId, userId: socket.data.userId },
          select: { id: true },
        });
        socket.data.attendanceId = row.id;
      } catch (err) {
        logger.warn(
          { err, sessionId, userId: socket.data.userId, isGuest: socket.data.isGuest },
          'failed to open attendance row',
        );
      }

      const me: Participant = {
        socketId: socket.id,
        userId: socket.data.userId,
        name: socket.data.name,
        role: member.role,
        hasHandRaised: false,
        isPublishing: socket.data.isPublishing,
        isMicOn: socket.data.isMicOn,
        isCamOn: socket.data.isCamOn,
      };
      socket.to(roomKey(sessionId)).emit('room:joined', me);
      const participants = await currentParticipants(sessionId);
      ack({ ok: true, participants });
      io.to(roomKey(sessionId)).emit('room:state', { participants });

      // Push chat + question backlog to the joining socket so late joiners
      // see the live conversation in full without depending on a separate
      // REST fetch (which can race / fail under guest-token edge cases).
      // Best-effort — failures are logged but never break the join.
      void (async () => {
        try {
          const [chatRows, qRows] = await Promise.all([
            prisma.sessionChatMessage.findMany({
              where: { sessionId },
              include: { user: { select: { name: true } } },
              orderBy: { createdAt: 'asc' },
              take: 500,
            }),
            prisma.sessionQuestion.findMany({
              where: { sessionId },
              include: {
                askedBy: { select: { name: true } },
                answeredBy: { select: { name: true } },
              },
              orderBy: { createdAt: 'asc' },
              take: 200,
            }),
          ]);

          const chatHistory = chatRows.map((m) => ({
            id: m.id,
            sessionId: m.sessionId,
            userId: m.userId ?? '',
            userName: m.user?.name ?? m.guestName ?? 'Guest',
            userRole: CourseRole.STUDENT,
            text: m.text ?? '',
            attachment: m.attachmentKey
              ? {
                  key: m.attachmentKey,
                  name: m.attachmentName ?? 'attachment',
                  mimeType: m.attachmentMimeType ?? 'application/octet-stream',
                  size: m.attachmentSize ?? 0,
                }
              : null,
            createdAt: m.createdAt.toISOString(),
          }));
          socket.emit('chat:history', chatHistory);

          const questionHistory = qRows.map((q) => ({
            id: q.id,
            sessionId: q.sessionId,
            askedByUserId: q.askedByUserId,
            askedByName: q.askedBy?.name ?? q.askedGuestName ?? 'Guest',
            text: q.text,
            answeredAt: q.answeredAt?.toISOString() ?? null,
            answeredByUserId: q.answeredByUserId,
            answeredByName: q.answeredBy?.name ?? null,
            answerText: q.answerText,
            createdAt: q.createdAt.toISOString(),
          }));
          socket.emit('question:history', questionHistory);
        } catch (err) {
          logger.warn(
            { err, sessionId, userId: socket.data.userId },
            'failed to push backlog on join',
          );
        }
      })();
    });

    socket.on('room:leave', async (sessionId) => {
      socket.leave(roomKey(sessionId));
      socket.to(roomKey(sessionId)).emit('room:left', {
        socketId: socket.id,
        userId: socket.data.userId,
        name: socket.data.name,
      });
      await closeAttendance(socket.data.attendanceId);
      socket.data.attendanceId = undefined;
      if (socket.data.joinedSessionId === sessionId) {
        socket.data.joinedSessionId = undefined;
      }
    });

    socket.on('chat:send', async ({ sessionId, text, attachment }) => {
      if (socket.data.joinedSessionId !== sessionId) return;
      const trimmed = (text ?? '').trim();
      if (!trimmed && !attachment) return;
      if (trimmed.length > 1000) return;
      const member = await getMembership(socket.data.userId, sessionId, { isGuest: socket.data.isGuest, guestCourseId: socket.data.guestCourseId });
      if (!member) return;
      // Guests have no User row → store userId=null + guestName so the FK
      // doesn't trip. Display layer falls back to guestName when user is null.
      const isGuest = socket.data.isGuest;
      const row = await prisma.sessionChatMessage.create({
        data: {
          sessionId,
          userId: isGuest ? undefined : socket.data.userId,
          guestName: isGuest ? socket.data.name : undefined,
          text: trimmed,
          attachmentKey: attachment?.key,
          attachmentName: attachment?.name,
          attachmentMimeType: attachment?.mimeType,
          attachmentSize: attachment?.size,
        },
      });
      const msg: ChatMessage = {
        id: row.id,
        sessionId,
        userId: socket.data.userId,
        userName: socket.data.name,
        userRole: member.role,
        text: row.text,
        attachment: row.attachmentKey
          ? {
              key: row.attachmentKey,
              name: row.attachmentName ?? 'attachment',
              mimeType: row.attachmentMimeType ?? 'application/octet-stream',
              size: row.attachmentSize ?? 0,
            }
          : null,
        createdAt: row.createdAt.toISOString(),
      };
      io.to(roomKey(sessionId)).emit('chat:new', msg);
    });

    socket.on('question:ask', async ({ sessionId, text }) => {
      if (!text?.trim() || text.length > 500) return;
      const member = await getMembership(socket.data.userId, sessionId, { isGuest: socket.data.isGuest, guestCourseId: socket.data.guestCourseId });
      if (!member) return;
      const isGuest = socket.data.isGuest;
      const row = await prisma.sessionQuestion.create({
        data: {
          sessionId,
          askedByUserId: isGuest ? null : socket.data.userId,
          askedGuestName: isGuest ? socket.data.name : null,
          text: text.trim(),
        },
      });
      const q: Question = {
        id: row.id,
        sessionId,
        askedByUserId: socket.data.userId,
        askedByName: socket.data.name,
        text: row.text,
        answeredAt: null,
        answeredByUserId: null,
        answeredByName: null,
        answerText: null,
        createdAt: row.createdAt.toISOString(),
      };
      io.to(roomKey(sessionId)).emit('question:new', q);
    });

    socket.on('question:answer', async ({ sessionId, questionId, answerText }) => {
      if (!answerText?.trim() || answerText.length > 2000) return;
      const member = await getMembership(socket.data.userId, sessionId, { isGuest: socket.data.isGuest, guestCourseId: socket.data.guestCourseId });
      if (!member || !isTeacher(member.role)) return;
      const row = await prisma.sessionQuestion.update({
        where: { id: questionId },
        data: {
          answerText: answerText.trim(),
          answeredAt: new Date(),
          answeredByUserId: socket.data.userId,
        },
        include: { askedBy: true, answeredBy: true },
      });
      const q: Question = {
        id: row.id,
        sessionId: row.sessionId,
        askedByUserId: row.askedByUserId,
        // Fall back to guest name when the asker had no User row.
        askedByName: row.askedBy?.name ?? row.askedGuestName ?? 'Guest',
        text: row.text,
        answeredAt: row.answeredAt!.toISOString(),
        answeredByUserId: row.answeredByUserId,
        answeredByName: row.answeredBy?.name ?? null,
        answerText: row.answerText,
        createdAt: row.createdAt.toISOString(),
      };
      io.to(roomKey(sessionId)).emit('question:answered', q);
    });

    socket.on('hand:raise', async ({ sessionId, raised }) => {
      if (socket.data.joinedSessionId !== sessionId) return;
      socket.data.hasHandRaised = raised;
      const member = await getMembership(socket.data.userId, sessionId, { isGuest: socket.data.isGuest, guestCourseId: socket.data.guestCourseId });
      if (!member) return;
      const p: Participant = {
        socketId: socket.id,
        userId: socket.data.userId,
        name: socket.data.name,
        role: member.role,
        hasHandRaised: raised,
        isPublishing: socket.data.isPublishing,
        isMicOn: socket.data.isMicOn,
        isCamOn: socket.data.isCamOn,
      };
      io.to(roomKey(sessionId)).emit('room:updated', p);
    });

    socket.on('hand:accept', async ({ sessionId, studentSocketId }) => {
      const member = await getMembership(socket.data.userId, sessionId, { isGuest: socket.data.isGuest, guestCourseId: socket.data.guestCourseId });
      if (!member || !isTeacher(member.role)) return;
      io.to(studentSocketId).emit('hand:accepted', { fromSocketId: socket.id });
      const target = io.sockets.sockets.get(studentSocketId);
      if (target) {
        target.data.isPublishing = true;
        // When the teacher accepts a hand, default the student's mic on
        // (the whole point of raising a hand is to be heard). Camera stays
        // off — the student can flip it on themselves.
        target.data.isMicOn = true;
        target.data.hasHandRaised = false;
      }
      io.to(roomKey(sessionId)).emit('room:state', {
        participants: await currentParticipants(sessionId),
      });
    });

    socket.on('media:toggle', async ({ sessionId, isMicOn, isCamOn }) => {
      if (socket.data.joinedSessionId !== sessionId) return;
      const member = await getMembership(socket.data.userId, sessionId, { isGuest: socket.data.isGuest, guestCourseId: socket.data.guestCourseId });
      if (!member) return;
      // Students only move their own mic/cam state after they've been
      // allowed to publish; teachers can always toggle their own.
      if (!isTeacher(member.role) && !socket.data.isPublishing) return;
      if (typeof isMicOn === 'boolean') socket.data.isMicOn = isMicOn;
      if (typeof isCamOn === 'boolean') socket.data.isCamOn = isCamOn;
      const p: Participant = {
        socketId: socket.id,
        userId: socket.data.userId,
        name: socket.data.name,
        role: member.role,
        hasHandRaised: socket.data.hasHandRaised,
        isPublishing: socket.data.isPublishing,
        isMicOn: socket.data.isMicOn,
        isCamOn: socket.data.isCamOn,
      };
      io.to(roomKey(sessionId)).emit('room:updated', p);
    });

    socket.on('hand:reject', async ({ sessionId, studentSocketId }) => {
      const member = await getMembership(socket.data.userId, sessionId, { isGuest: socket.data.isGuest, guestCourseId: socket.data.guestCourseId });
      if (!member || !isTeacher(member.role)) return;
      io.to(studentSocketId).emit('hand:rejected');
    });

    socket.on('media:stream-gone', ({ sessionId, streamId }) => {
      if (socket.data.joinedSessionId !== sessionId || !streamId) return;
      socket.to(roomKey(sessionId)).emit('media:stream-gone', {
        fromSocketId: socket.id,
        streamId,
      });
    });

    // WebRTC signaling relay
    socket.on('rtc:offer', ({ to, sdp }) => {
      io.to(to).emit('rtc:offer', { from: socket.id, sdp });
    });
    socket.on('rtc:answer', ({ to, sdp }) => {
      io.to(to).emit('rtc:answer', { from: socket.id, sdp });
    });
    socket.on('rtc:ice', ({ to, candidate }) => {
      io.to(to).emit('rtc:ice', { from: socket.id, candidate });
    });

    socket.on('disconnect', async () => {
      const sessionId = socket.data.joinedSessionId;
      await closeAttendance(socket.data.attendanceId);
      socket.data.attendanceId = undefined;
      if (sessionId) {
        socket.to(roomKey(sessionId)).emit('room:left', {
          socketId: socket.id,
          userId: socket.data.userId,
          name: socket.data.name,
        });
        // re-broadcast state to survivors
        currentParticipants(sessionId)
          .then((participants) =>
            io.to(roomKey(sessionId)).emit('room:state', { participants }),
          )
          .catch((err) => logger.warn({ err, sessionId }, 'failed to rebroadcast room state'));
      }
      logger.info({ userId: socket.data.userId }, 'socket disconnected');
    });
  });

  return io;
}
