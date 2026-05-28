import type {
  MultipartPart,
  StorageGateway,
} from '../../domain/ports/StorageGateway.js';
import type { RecordingRepository } from '../../domain/ports/RecordingRepository.js';
import type { TaskRepository } from '../../domain/ports/TaskRepository.js';

export type CompleteRecordingInput = {
  recordingId: string;
  parts: MultipartPart[];
};

export type CompleteRecordingResult = {
  taskId: string;
  /** True when the multipart upload was already completed in a previous call. */
  alreadyCompleted: boolean;
};

/**
 * Finalize the S3 multipart upload (idempotent — a duplicate completion
 * call from the browser must not error) and enqueue a Task to drive the
 * post-process pipeline (transcode, audio extraction, transcribe, …).
 *
 * Returns the taskId so the caller can show "queued" in the UI without
 * a second round-trip.
 */
export class CompleteRecording {
  constructor(
    private readonly recordings: RecordingRepository,
    private readonly tasks: TaskRepository,
    private readonly storage: StorageGateway,
  ) {}

  async execute(input: CompleteRecordingInput): Promise<CompleteRecordingResult> {
    const recording = await this.recordings.findById(input.recordingId);
    if (!recording) throw new Error('recording not found');
    if (!recording.rawKey) throw new Error('recording has no rawKey');

    // Idempotency: if s3UploadId is null we've already completed (or were
    // never multipart). Just create the task — don't try to complete twice.
    let alreadyCompleted = false;
    if (recording.s3UploadId) {
      await this.storage.completeMultipart(
        recording.rawKey,
        recording.s3UploadId,
        input.parts,
      );
    } else {
      alreadyCompleted = true;
    }

    await this.recordings.setStatus(recording.id, 'PROCESSING');

    const task = await this.tasks.create({
      type: 'RECORDING_PIPELINE',
      recordingId: recording.id,
    });

    return { taskId: task.id, alreadyCompleted };
  }
}
