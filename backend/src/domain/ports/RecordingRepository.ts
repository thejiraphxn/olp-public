import type {
  Chapter,
  Recording,
  RecordingStatus,
  TranscriptSegment,
} from '../entities/Recording.js';

export type ReadyVideoUpdate = {
  playbackKey: string;
  thumbnailKey: string | null;
  durationSec: number;
  sizeBytes: bigint;
};

/**
 * Persistence port for SessionRecording. Implementation lives in
 * `infrastructure/db/PrismaRecordingRepository.ts`.
 *
 * Methods here express *what* business changes — none of them leak
 * Prisma types upward. Use-cases compose them to drive the lifecycle.
 */
export interface RecordingRepository {
  findById(id: string): Promise<Recording | null>;
  findBySessionId(sessionId: string): Promise<Recording | null>;

  setStatus(id: string, status: RecordingStatus): Promise<void>;

  /** After transcode + upload finishes, mark the row READY in one shot. */
  markVideoReady(id: string, update: ReadyVideoUpdate): Promise<void>;

  /** Hard fail. errorMessage is truncated by the impl if needed. */
  markFailed(id: string, errorMessage: string): Promise<void>;

  setAudioKey(id: string, key: string): Promise<void>;
  setTranscript(id: string, segments: TranscriptSegment[]): Promise<void>;
  setAutoSummary(id: string, summary: string): Promise<void>;
  setAutoChapters(id: string, chapters: Chapter[]): Promise<void>;

  /**
   * Re-arm a failed recording for another pipeline run. Clears
   * errorMessage and forces status back to PROCESSING.
   */
  resetForRetry(id: string): Promise<void>;

  /**
   * Used by the upload-init flow to clear stale state before a fresh
   * recording attempt (after a previous FAILED).
   */
  clearProcessedArtifacts(id: string): Promise<void>;
}
