import { Router } from 'express';
import { z } from 'zod';
import { CourseRole, RecordingStatus, SessionStatus } from '@prisma/client';
import { prisma } from '../../lib/prisma.js';
import { requireAuth, requireCourseRole } from '../../middleware/auth.js';
import {
  createMultipart,
  presignUploadPart,
  abortMultipart,
  cleanupRecordingS3,
} from '../storage/s3.js';
import { getContainer } from '../../composition.js';
import { logger } from '../../lib/logger.js';

export const recordingsRouter = Router({ mergeParams: true });

recordingsRouter.use(requireAuth);

// Init: allocate SessionRecording row + S3 multipart upload
recordingsRouter.post(
  '/',
  requireCourseRole('courseId', [CourseRole.TEACHER]),
  async (req, res, next) => {
    try {
      const { sessionId } = req.params;
      const session = await prisma.courseSession.findUnique({ where: { id: sessionId } });
      if (!session || session.courseId !== req.params.courseId)
        return res.status(404).json({ error: 'session not found' });

      // one recording per session
      const existing = await prisma.sessionRecording.findUnique({ where: { sessionId } });
      if (
        existing &&
        ([RecordingStatus.PROCESSING, RecordingStatus.READY] as RecordingStatus[]).includes(
          existing.status,
        )
      )
        return res.status(409).json({ error: 'recording already finalized' });

      const rawKey = `raw/${sessionId}/${Date.now()}.webm`;
      let s3UploadId: string;
      try {
        s3UploadId = await createMultipart(rawKey);
      } catch (e: unknown) {
        // Most common cause in dev: MinIO container not running.
        // Surface a friendlier message than a bare 500.
        const msg = String((e as Error)?.message ?? e);
        logger.error({ err: msg, rawKey }, 'createMultipart failed');
        return res.status(503).json({
          error: 'storage unavailable',
          detail:
            /ECONN|ENOTFOUND|getaddrinfo/i.test(msg)
              ? 'Object storage (MinIO/S3) is not reachable. In dev: `docker compose up -d minio minio-init`. In prod: check the api container can reach the S3 endpoint.'
              : msg.slice(0, 300),
        });
      }

      const recording = existing
        ? await prisma.sessionRecording.update({
            where: { id: existing.id },
            data: {
              status: RecordingStatus.UPLOADING,
              rawKey,
              s3UploadId,
              playbackKey: null,
              durationSec: null,
              errorMessage: null,
            },
          })
        : await prisma.sessionRecording.create({
            data: { sessionId, status: RecordingStatus.UPLOADING, rawKey, s3UploadId },
          });

      await prisma.courseSession.update({
        where: { id: sessionId },
        data: { status: SessionStatus.LIVE, startedAt: new Date() },
      });

      res.status(201).json({
        recordingId: recording.id,
        rawKey,
        s3UploadId,
      });
    } catch (e) {
      next(e);
    }
  },
);

// Presigned URL for a single part (1-indexed)
recordingsRouter.post(
  '/:recordingId/part-url',
  requireCourseRole('courseId', [CourseRole.TEACHER]),
  async (req, res, next) => {
    try {
      const { partNumber } = z
        .object({ partNumber: z.number().int().min(1).max(10000) })
        .parse(req.body);
      const recording = await prisma.sessionRecording.findUnique({
        where: { id: req.params.recordingId },
      });
      if (!recording || !recording.rawKey || !recording.s3UploadId)
        return res.status(404).json({ error: 'not found' });
      const url = await presignUploadPart(recording.rawKey, recording.s3UploadId, partNumber);
      res.json({ url, partNumber });
    } catch (e) {
      next(e);
    }
  },
);

// Client reports all parts uploaded → complete S3 multipart → enqueue processing
const completeSchema = z.object({
  parts: z
    .array(z.object({ PartNumber: z.number().int().min(1), ETag: z.string().min(1) }))
    .min(1),
});

recordingsRouter.post(
  '/:recordingId/complete',
  requireCourseRole('courseId', [CourseRole.TEACHER]),
  async (req, res, next) => {
    try {
      const { parts } = completeSchema.parse(req.body);
      const result = await getContainer(req).useCases.completeRecording.execute({
        recordingId: req.params.recordingId,
        parts,
      });

      // Side-effect that's still HTTP-shaped: mark the session ENDED.
      // Belongs in a session use-case in the long run; keeping inline
      // here for now so we don't grow Phase 1 scope.
      const recording = await prisma.sessionRecording.findUnique({
        where: { id: req.params.recordingId },
        select: { sessionId: true },
      });
      if (recording) {
        await prisma.courseSession.update({
          where: { id: recording.sessionId },
          data: { status: SessionStatus.ENDED, endedAt: new Date() },
        });
      }

      logger.info(
        {
          recordingId: req.params.recordingId,
          taskId: result.taskId,
          alreadyCompleted: result.alreadyCompleted,
        },
        'recording finalized; task enqueued',
      );
      res.json({ ok: true, taskId: result.taskId });
    } catch (e) {
      next(e);
    }
  },
);

// Abort — used when the client crashes mid-upload
recordingsRouter.post(
  '/:recordingId/abort',
  requireCourseRole('courseId', [CourseRole.TEACHER]),
  async (req, res, next) => {
    try {
      const recording = await prisma.sessionRecording.findUnique({
        where: { id: req.params.recordingId },
      });
      if (!recording) return res.status(404).json({ error: 'not found' });
      if (recording.rawKey && recording.s3UploadId)
        await abortMultipart(recording.rawKey, recording.s3UploadId);
      await prisma.sessionRecording.update({
        where: { id: recording.id },
        data: { status: RecordingStatus.FAILED, errorMessage: 'Aborted by teacher', s3UploadId: null },
      });
      res.json({ ok: true });
    } catch (e) {
      next(e);
    }
  },
);

// Save chapters (teacher marks chapters during recording)
const chaptersSchema = z.object({
  chapters: z
    .array(
      z.object({
        timeSec: z.number().int().min(0),
        label: z.string().min(1).max(120),
      }),
    )
    .max(50),
});

recordingsRouter.put(
  '/:recordingId/chapters',
  requireCourseRole('courseId', [CourseRole.TEACHER]),
  async (req, res, next) => {
    try {
      const { chapters } = chaptersSchema.parse(req.body);
      const recording = await prisma.sessionRecording.update({
        where: { id: req.params.recordingId },
        data: { chapters: chapters.sort((a, b) => a.timeSec - b.timeSec) },
      });
      res.json(recording);
    } catch (e) {
      next(e);
    }
  },
);

// Reset a stuck recording — wipes state and deletes the row so the teacher
// can start a fresh recording. Use this when the recording is stuck in
// UPLOADING/PROCESSING with no raw upload or an uploadable raw file.
recordingsRouter.post(
  '/:recordingId/reset',
  requireCourseRole('courseId', [CourseRole.TEACHER]),
  async (req, res, next) => {
    try {
      const recording = await prisma.sessionRecording.findUnique({
        where: { id: req.params.recordingId },
        select: {
          id: true,
          sessionId: true,
          rawKey: true,
          playbackKey: true,
          audioKey: true,
          thumbnailKey: true,
          s3UploadId: true,
        },
      });
      if (!recording) return res.status(404).json({ error: 'not found' });

      // Abort any in-flight multipart upload + delete every uploaded artifact
      // (raw / playback / audio / thumb). Best-effort: failures are logged.
      await cleanupRecordingS3(recording);
      await prisma.sessionRecording.delete({ where: { id: recording.id } });
      // Also revert the session back to SCHEDULED so the "Start recording"
      // button is available again.
      await prisma.courseSession.update({
        where: { id: recording.sessionId },
        data: { status: SessionStatus.SCHEDULED, startedAt: null, endedAt: null },
      });
      res.json({ ok: true });
    } catch (e) {
      next(e);
    }
  },
);

// Save / clear the teacher's manual summary. Empty string clears the
// override and falls back to the AI summary on display.
recordingsRouter.put(
  '/:recordingId/summary',
  requireCourseRole('courseId', [CourseRole.TEACHER]),
  async (req, res, next) => {
    try {
      const text = String(req.body?.text ?? '').trim().slice(0, 2000);
      const recording = await prisma.sessionRecording.update({
        where: { id: req.params.recordingId },
        data: { summary: text || null },
        select: { id: true, summary: true, autoSummary: true },
      });
      res.json({ ok: true, summary: recording.summary, autoSummary: recording.autoSummary });
    } catch (e) {
      next(e);
    }
  },
);

// Retry a failed recording — re-enqueues the process job if raw exists.
//
// Status handling:
//   - READY  → keep status as READY, only clear errorMessage. The video +
//              transcript stay viewable while the LLM stage retries in the
//              background. Without this, flipping to PROCESSING would hide
//              the playback URL and feel like the page hung.
//   - other  → flip to PROCESSING (the upstream stages need real work).
recordingsRouter.post(
  '/:recordingId/retry',
  requireCourseRole('courseId', [CourseRole.TEACHER]),
  async (req, res, next) => {
    try {
      const recording = await prisma.sessionRecording.findUnique({
        where: { id: req.params.recordingId },
        select: { id: true, rawKey: true, status: true },
      });
      if (!recording) return res.status(404).json({ error: 'not found' });
      if (!recording.rawKey)
        return res.status(400).json({ error: 'no raw upload to retry' });

      // Keep the READY → "only clear errorMessage" UX from before:
      // the video stays viewable while LLM stages re-run.
      if (recording.status === RecordingStatus.READY) {
        await prisma.sessionRecording.update({
          where: { id: recording.id },
          data: { errorMessage: null },
        });
      }

      const result = await getContainer(req).useCases.retryRecording.execute({
        recordingId: recording.id,
      });
      logger.info(
        { recordingId: recording.id, taskId: result.taskId },
        'recording retry enqueued',
      );
      res.json({ ok: true, taskId: result.taskId });
    } catch (e) {
      next(e);
    }
  },
);

// Poll status
recordingsRouter.get(
  '/:recordingId',
  requireCourseRole('courseId', [CourseRole.TEACHER, CourseRole.STUDENT]),
  async (req, res, next) => {
    try {
      const recording = await prisma.sessionRecording.findUnique({
        where: { id: req.params.recordingId },
      });
      if (!recording) return res.status(404).json({ error: 'not found' });
      res.json(recording);
    } catch (e) {
      next(e);
    }
  },
);
