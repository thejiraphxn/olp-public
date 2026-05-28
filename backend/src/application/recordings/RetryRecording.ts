import type { RecordingRepository } from '../../domain/ports/RecordingRepository.js';
import type { TaskRepository } from '../../domain/ports/TaskRepository.js';

export type RetryRecordingInput = {
  recordingId: string;
};

export type RetryRecordingResult = {
  taskId: string;
};

/**
 * Re-arm a recording that previously FAILED — clears errorMessage,
 * resets status to PROCESSING, enqueues a new Task. Idempotency in the
 * worker handler will skip stages whose artifacts already exist.
 */
export class RetryRecording {
  constructor(
    private readonly recordings: RecordingRepository,
    private readonly tasks: TaskRepository,
  ) {}

  async execute(input: RetryRecordingInput): Promise<RetryRecordingResult> {
    const recording = await this.recordings.findById(input.recordingId);
    if (!recording) throw new Error('recording not found');

    await this.recordings.resetForRetry(recording.id);

    const task = await this.tasks.create({
      type: 'RECORDING_PIPELINE',
      recordingId: recording.id,
    });

    return { taskId: task.id };
  }
}
