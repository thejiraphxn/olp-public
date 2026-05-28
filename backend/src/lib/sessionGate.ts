/**
 * Session-level access-code gate. Stored as plaintext on `CourseSession`
 * (soft gate, not a security boundary). Code passes through:
 *
 *   HTTP:        request header `X-Session-Code: 123456`
 *   Socket.IO:   handshake `auth.sessionCode = '123456'`
 *
 * Every user — including the teacher who set the code — must supply it.
 * The teacher can see the raw value in the session detail response so it's
 * a one-off "type to confirm" step rather than something they have to
 * remember.
 */
import type { Request, Response, NextFunction } from 'express';
import { prisma } from './prisma.js';

/**
 * Returns true if the user is allowed to access this session's gated content.
 * Reads sessionId from req.params.sessionId.
 */
export async function passesSessionAccess(req: Request): Promise<boolean> {
  const sessionId = req.params.sessionId;
  if (!sessionId) return true; // route doesn't have :sessionId → not session-scoped

  const session = await prisma.courseSession.findUnique({
    where: { id: sessionId },
    select: { courseId: true, accessCode: true },
  });
  if (!session) return false; // 404 will be raised by the actual handler

  // No code → no gate.
  if (!session.accessCode) return true;

  const supplied = String(req.headers['x-session-code'] ?? '').trim();
  return supplied !== '' && supplied === session.accessCode;
}

/**
 * Express middleware variant. Use after `requireCourseRole` so we know
 * the user has read access to the course before checking the gate.
 */
export function requireSessionAccess(
  req: Request,
  res: Response,
  next: NextFunction,
) {
  passesSessionAccess(req)
    .then((ok) => {
      if (ok) return next();
      res.status(403).json({ error: 'session access code required', code: 'SESSION_GATED' });
    })
    .catch(next);
}
