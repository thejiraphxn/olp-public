/**
 * Typed enum values mirroring Prisma schema (backend/prisma/schema.prisma).
 *
 * Keep these in sync with the Prisma enums — treating them as the single
 * source of truth on the frontend avoids the hardcoded string drift we had
 * across pages.
 */

export const CourseRole = {
  TEACHER: 'TEACHER',
  STUDENT: 'STUDENT',
} as const;
export type CourseRole = (typeof CourseRole)[keyof typeof CourseRole];

export const SessionStatus = {
  DRAFT: 'DRAFT',
  SCHEDULED: 'SCHEDULED',
  LIVE: 'LIVE',
  ENDED: 'ENDED',
} as const;
export type SessionStatus = (typeof SessionStatus)[keyof typeof SessionStatus];

export const RecordingStatus = {
  PENDING: 'PENDING',
  UPLOADING: 'UPLOADING',
  PROCESSING: 'PROCESSING',
  READY: 'READY',
  FAILED: 'FAILED',
} as const;
export type RecordingStatus = (typeof RecordingStatus)[keyof typeof RecordingStatus];

export const CourseVisibility = {
  PRIVATE: 'PRIVATE',
  PUBLIC: 'PUBLIC',
} as const;
export type CourseVisibility = (typeof CourseVisibility)[keyof typeof CourseVisibility];

// Default palette used when a course has no coverColor set.
export const DEFAULT_COURSE_COVERS = ['#ffd5b8', '#d8e4ff', '#e4d8ff', '#d6ead9', '#f3e3c9'] as const;

export function pickCourseCover(seed: string): string {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) | 0;
  return DEFAULT_COURSE_COVERS[Math.abs(h) % DEFAULT_COURSE_COVERS.length];
}
