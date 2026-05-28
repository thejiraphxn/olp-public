import type { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { config } from '../config.js';
import { prisma } from '../lib/prisma.js';
import { CourseVisibility, type CourseRole } from '@prisma/client';

declare global {
  namespace Express {
    interface Request {
      userId?: string;
      // True when the JWT was minted via /auth/guest. Guest IDs do NOT exist
      // in the User table — never write them to FK columns.
      isGuest?: boolean;
      guestName?: string;
      // The PUBLIC course the guest token was scoped to. Used to keep guests
      // pinned to one course and prevent course-id swap attacks.
      guestCourseId?: string;
    }
  }
}

type JwtPayload = {
  sub: string;
  guest?: boolean;
  name?: string;
  courseId?: string;
};

export function requireAuth(req: Request, res: Response, next: NextFunction) {
  const header = req.headers.authorization;
  const bearer = header?.startsWith('Bearer ') ? header.slice(7) : null;
  const cookieToken = (req as any).cookies?.olp_token;
  const token = bearer ?? cookieToken;
  if (!token) return res.status(401).json({ error: 'unauthenticated' });
  try {
    const payload = jwt.verify(token, config.jwtSecret) as JwtPayload;
    req.userId = payload.sub;
    if (payload.guest) {
      req.isGuest = true;
      req.guestName = payload.name;
      req.guestCourseId = payload.courseId;
    }
    next();
  } catch {
    return res.status(401).json({ error: 'invalid token' });
  }
}

export async function assertCourseRole(
  userId: string,
  courseId: string,
  allowed: CourseRole[],
) {
  const member = await prisma.courseMember.findUnique({
    where: { courseId_userId: { courseId, userId } },
  });
  if (!member || !allowed.includes(member.role)) {
    const err: any = new Error('forbidden');
    err.status = 403;
    throw err;
  }
  return member;
}

/**
 * Gate routes by course-level role. Options:
 *  - allowed: allowed roles
 *  - allowPublicRead: if true, users who aren't members of a PUBLIC course
 *    can also access (used for read-only endpoints on public courses).
 *
 * Guest token semantics:
 *  - Guests are admitted ONLY to allowPublicRead routes.
 *  - The course must be PUBLIC.
 *  - The course id must match the courseId the guest token was scoped to —
 *    a guest token for course A cannot read course B even if B is PUBLIC.
 */
export function requireCourseRole(
  paramName: string,
  allowed: CourseRole[],
  opts: { allowPublicRead?: boolean } = {},
) {
  return async (req: Request, res: Response, next: NextFunction) => {
    try {
      const courseId = req.params[paramName];
      if (!req.userId) return res.status(401).json({ error: 'unauthenticated' });

      if (req.isGuest) {
        if (!opts.allowPublicRead) return res.status(403).json({ error: 'forbidden' });
        if (req.guestCourseId && req.guestCourseId !== courseId) {
          return res.status(403).json({ error: 'forbidden' });
        }
        const course = await prisma.course.findUnique({
          where: { id: courseId },
          select: { visibility: true },
        });
        if (course?.visibility === CourseVisibility.PUBLIC) return next();
        return res.status(403).json({ error: 'forbidden' });
      }

      const member = await prisma.courseMember.findUnique({
        where: { courseId_userId: { courseId, userId: req.userId } },
      });
      if (member && allowed.includes(member.role)) return next();
      if (opts.allowPublicRead) {
        const course = await prisma.course.findUnique({
          where: { id: courseId },
          select: { visibility: true },
        });
        if (course?.visibility === CourseVisibility.PUBLIC) return next();
      }
      return res.status(403).json({ error: 'forbidden' });
    } catch (e: any) {
      res.status(e.status ?? 500).json({ error: e.message });
    }
  };
}
