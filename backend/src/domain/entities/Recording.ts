/**
 * Recording — domain view of a SessionRecording row. Repositories own the
 * mapping to/from Prisma. Layers above use this type only.
 */

export type RecordingStatus =
  | 'PENDING'
  | 'UPLOADING'
  | 'PROCESSING'
  | 'READY'
  | 'FAILED';

export type TranscriptSegment = {
  startSec: number;
  endSec: number;
  text: string;
};

export type Chapter = {
  timeSec: number;
  label: string;
};

export type Recording = {
  id: string;
  sessionId: string;
  status: RecordingStatus;
  rawKey: string | null;
  playbackKey: string | null;
  audioKey: string | null;
  thumbnailKey: string | null;
  // S3 multipart upload details — present while the upload is in flight,
  // null once `completeMultipart` has flushed all parts. The use-case
  // that finalizes uploads needs them to call into StorageGateway.
  uploadId: string | null;
  s3UploadId: string | null;
  transcript: TranscriptSegment[] | null;
  summary: string | null;       // teacher-authored manual override
  autoSummary: string | null;   // LLM-generated fallback
  chapters: Chapter[] | null;   // teacher-authored
  autoChapters: Chapter[] | null;
  durationSec: number | null;
  sizeBytes: bigint | null;
  errorMessage: string | null;
};
