import {
  Prisma,
  type PrismaClient,
  type SessionRecording as PrismaRecordingRow,
} from '@prisma/client';
import type {
  ReadyVideoUpdate,
  RecordingRepository,
} from '../../domain/ports/RecordingRepository.js';
import type {
  Chapter,
  Recording,
  RecordingStatus,
  TranscriptSegment,
} from '../../domain/entities/Recording.js';

function toDomain(row: PrismaRecordingRow): Recording {
  return {
    id: row.id,
    sessionId: row.sessionId,
    status: row.status as RecordingStatus,
    rawKey: row.rawKey,
    playbackKey: row.playbackKey,
    audioKey: row.audioKey,
    thumbnailKey: row.thumbnailKey,
    uploadId: row.uploadId,
    s3UploadId: row.s3UploadId,
    transcript: Array.isArray(row.transcript)
      ? (row.transcript as unknown as TranscriptSegment[])
      : null,
    summary: row.summary,
    autoSummary: row.autoSummary,
    chapters: Array.isArray(row.chapters)
      ? (row.chapters as unknown as Chapter[])
      : null,
    autoChapters: Array.isArray(row.autoChapters)
      ? (row.autoChapters as unknown as Chapter[])
      : null,
    durationSec: row.durationSec,
    sizeBytes: row.sizeBytes,
    errorMessage: row.errorMessage,
  };
}

export class PrismaRecordingRepository implements RecordingRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async findById(id: string): Promise<Recording | null> {
    const row = await this.prisma.sessionRecording.findUnique({ where: { id } });
    return row ? toDomain(row) : null;
  }

  async findBySessionId(sessionId: string): Promise<Recording | null> {
    const row = await this.prisma.sessionRecording.findUnique({
      where: { sessionId },
    });
    return row ? toDomain(row) : null;
  }

  async setStatus(id: string, status: RecordingStatus): Promise<void> {
    await this.prisma.sessionRecording.update({ where: { id }, data: { status } });
  }

  async markVideoReady(id: string, update: ReadyVideoUpdate): Promise<void> {
    await this.prisma.sessionRecording.update({
      where: { id },
      data: {
        status: 'READY',
        playbackKey: update.playbackKey,
        thumbnailKey: update.thumbnailKey,
        durationSec: update.durationSec,
        sizeBytes: update.sizeBytes,
        errorMessage: null,
      },
    });
  }

  async markFailed(id: string, errorMessage: string): Promise<void> {
    await this.prisma.sessionRecording.update({
      where: { id },
      data: {
        status: 'FAILED',
        errorMessage: errorMessage.slice(0, 500),
      },
    });
  }

  async setAudioKey(id: string, key: string): Promise<void> {
    await this.prisma.sessionRecording.update({
      where: { id },
      data: { audioKey: key },
    });
  }

  async setTranscript(id: string, segments: TranscriptSegment[]): Promise<void> {
    await this.prisma.sessionRecording.update({
      where: { id },
      data: { transcript: segments as unknown as object },
    });
  }

  async setAutoSummary(id: string, summary: string): Promise<void> {
    await this.prisma.sessionRecording.update({
      where: { id },
      data: { autoSummary: summary },
    });
  }

  async setAutoChapters(id: string, chapters: Chapter[]): Promise<void> {
    await this.prisma.sessionRecording.update({
      where: { id },
      data: { autoChapters: chapters as unknown as object },
    });
  }

  async resetForRetry(id: string): Promise<void> {
    // Goal: clicking "Re-generate" always does work, even when the
    // recording is fully done. ProcessRecordingTask short-circuits when
    // transcript + autoSummary both exist, so we clear the LLM-stage
    // artefacts here to force a fresh handoff. Transcript stays — it's
    // expensive to regenerate and rarely the thing the teacher wants to
    // change. (For a full re-transcribe, clear transcript via the DB or
    // add a separate "deep regenerate" button later.)
    //
    // Status logic:
    //  - mp4 exists → keep status=READY so viewers can still watch the
    //    video while the LLM re-run is in flight.
    //  - no mp4 → drop to PROCESSING (true full retry from a failed
    //    transcode).
    const current = await this.prisma.sessionRecording.findUnique({
      where: { id },
      select: { playbackKey: true },
    });
    await this.prisma.sessionRecording.update({
      where: { id },
      data: {
        status: current?.playbackKey ? 'READY' : 'PROCESSING',
        errorMessage: null,
        // Force the worker to run the LLM stage again. Prisma.JsonNull
        // clears the JSONB column properly (passing `null` would leave
        // the field unchanged in Prisma's update semantics).
        autoSummary: null,
        autoChapters: Prisma.JsonNull,
      },
    });
  }

  async clearProcessedArtifacts(id: string): Promise<void> {
    await this.prisma.sessionRecording.update({
      where: { id },
      data: {
        playbackKey: null,
        audioKey: null,
        thumbnailKey: null,
        transcript: undefined,
        autoSummary: null,
        autoChapters: undefined,
        durationSec: null,
        sizeBytes: null,
        errorMessage: null,
      },
    });
  }
}
