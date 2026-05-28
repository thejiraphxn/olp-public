import { Router } from 'express';
import { CourseRole, RecordingStatus } from '@prisma/client';
import { prisma } from '../../lib/prisma.js';
import { requireAuth, requireCourseRole } from '../../middleware/auth.js';
import { requireSessionAccess } from '../../lib/sessionGate.js';
import { presignGet, presignGetDownload } from '../storage/s3.js';
import { isTerminal } from '../../domain/entities/Task.js';

export const playbackRouter = Router({ mergeParams: true });

playbackRouter.use(requireAuth);

playbackRouter.get(
  '/',
  requireCourseRole('courseId', [CourseRole.TEACHER, CourseRole.STUDENT], { allowPublicRead: true }),
  requireSessionAccess,
  async (req, res, next) => {
    try {
      const session = await prisma.courseSession.findUnique({
        where: { id: req.params.sessionId },
        include: { recording: true },
      });
      if (!session || session.courseId !== req.params.courseId)
        return res.status(404).json({ error: 'session not found' });
      if (!session.recording) {
        return res.status(404).json({ error: 'no recording' });
      }
      const rec = session.recording;
      // Always return whatever's available — transcript may already be in
      // the DB while video transcode is still running, or while a re-run is
      // re-doing the LLM stage. The UI uses `ready` to decide whether to
      // render the <video> player; everything else (transcript, summary,
      // chapters) renders independently as soon as it exists.
      const isReady = rec.status === RecordingStatus.READY && !!rec.playbackKey;

      // Force-download URLs are TEACHER-only — students/guests stream the
      // mp4 inline via the regular playback URL. Detect membership the
      // same way sessions.routes.ts does.
      const isTeacher =
        !!req.userId &&
        !req.isGuest &&
        !!(await prisma.courseMember
          .findUnique({
            where: {
              courseId_userId: {
                courseId: session.courseId,
                userId: req.userId,
              },
            },
            select: { role: true },
          })
          .then((m) => m?.role === CourseRole.TEACHER));
      const slug = (session.title || 'recording')
        .toLowerCase()
        .replace(/\s+/g, '-');
      const [url, thumbnailUrl, audioUrl, downloadUrl, audioDownloadUrl, latestTask] = await Promise.all([
        isReady && rec.playbackKey ? presignGet(rec.playbackKey) : Promise.resolve(null),
        rec.thumbnailKey ? presignGet(rec.thumbnailKey) : Promise.resolve(null),
        rec.audioKey ? presignGet(rec.audioKey) : Promise.resolve(null),
        isTeacher && isReady && rec.playbackKey
          ? presignGetDownload(rec.playbackKey, `${slug}.mp4`)
          : Promise.resolve(null),
        isTeacher && rec.audioKey
          ? presignGetDownload(rec.audioKey, `${slug}.mp3`)
          : Promise.resolve(null),
        prisma.task.findFirst({
          where: { recordingId: rec.id },
          orderBy: { createdAt: 'desc' },
          select: {
            id: true,
            status: true,
            attempts: true,
            errorMessage: true,
            startedAt: true,
            completedAt: true,
          },
        }),
      ]);
      // Prefer manual chapters; fall back to LLM-generated ones.
      const manual = (rec.chapters as any[]) ?? [];
      const auto = (rec.autoChapters as any[]) ?? [];
      const chapters = manual.length > 0 ? manual : auto;
      // Same pattern for summary — teacher's text wins, AI is fallback.
      const summarySource: 'manual' | 'auto' | 'none' = rec.summary
        ? 'manual'
        : rec.autoSummary
          ? 'auto'
          : 'none';
      res.json({
        ready: isReady,
        status: rec.status,
        url,
        thumbnailUrl,
        audioUrl,
        downloadUrl,
        audioDownloadUrl,
        durationSec: rec.durationSec,
        chapters,
        chaptersSource:
          manual.length > 0 ? 'manual' : auto.length > 0 ? 'auto' : 'none',
        summary: rec.summary ?? rec.autoSummary,   // resolved (manual ?? auto)
        manualSummary: rec.summary,                 // raw fields so UI can edit/clear
        autoSummary: rec.autoSummary,
        summarySource,
        transcript: rec.transcript ?? [],
        // Non-fatal post-process error (e.g. LLM 404 / wrong model). Lets
        // the UI explain why summary/auto-chapters are empty when the
        // video itself is fine.
        postProcessError: rec.errorMessage?.startsWith('post-process:')
          ? rec.errorMessage.replace(/^post-process:\s*/, '')
          : null,
        // Latest pipeline task — drives the status badge in the UI.
        // `pollable` tells the frontend whether to keep refetching.
        task: latestTask
          ? {
              id: latestTask.id,
              status: latestTask.status,
              attempts: latestTask.attempts,
              errorMessage: latestTask.errorMessage,
              startedAt: latestTask.startedAt,
              completedAt: latestTask.completedAt,
              pollable: !isTerminal(latestTask.status as never),
            }
          : null,
        expiresInSec: 60 * 30,
      });
    } catch (e) {
      next(e);
    }
  },
);
