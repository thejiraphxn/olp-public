import type { Task } from '../../domain/entities/Task.js';
import type { RecordingRepository } from '../../domain/ports/RecordingRepository.js';
import type { TaskRepository } from '../../domain/ports/TaskRepository.js';
import type { StorageGateway } from '../../domain/ports/StorageGateway.js';
import type { MediaPipeline } from '../../domain/ports/MediaPipeline.js';
import type { WhisperGateway } from '../../domain/ports/WhisperGateway.js';
import type { Workspace } from '../../domain/ports/Workspace.js';
import { makeLogEntry } from '../shared/log.js';

/**
 * Drives a `RECORDING_PIPELINE` task through the Node-owned half of
 * the pipeline:
 *
 *   TRANSCODING → THUMBNAIL → EXTRACTING_AUDIO → UPLOADING_AUDIO → HANDED_OFF
 *
 * After HANDED_OFF, ownership passes to the Python whisper-server,
 * which writes the transcript + summary directly to Postgres and marks
 * the task COMPLETED. This handler returns once Python accepts the
 * task (HTTP 202).
 *
 * Stage gates make the handler idempotent — re-running on a
 * partially-finished recording skips stages whose artifacts already
 * exist. If transcript + autoSummary are both present, the handler
 * marks the task COMPLETED without handing off again.
 */
export class ProcessRecordingTask {
  constructor(
    private readonly tasks: TaskRepository,
    private readonly recordings: RecordingRepository,
    private readonly storage: StorageGateway,
    private readonly media: MediaPipeline,
    private readonly whisper: WhisperGateway,
    private readonly workspace: Workspace,
  ) {}

  async execute(task: Task): Promise<void> {
    if (!task.recordingId) {
      throw new Error('RECORDING_PIPELINE task missing recordingId');
    }
    const recording = await this.recordings.findById(task.recordingId);
    if (!recording) throw new Error('recording not found');
    if (!recording.rawKey) throw new Error('recording has no rawKey');

    const tmp = await this.workspace.create('olp-task-');
    const rawFile = tmp.pathOf('in.webm');
    const mp4File = tmp.pathOf('out.mp4');
    const mp3File = tmp.pathOf('audio.mp3');
    const thumbFile = tmp.pathOf('thumb.jpg');

    try {
      // ── Idempotency probes ──────────────────────────────────────
      const hasMp4 = !!recording.playbackKey;
      const hasAudio = !!recording.audioKey;
      const hasTranscript =
        Array.isArray(recording.transcript) && recording.transcript.length > 0;
      const hasAutoSummary =
        typeof recording.autoSummary === 'string' &&
        recording.autoSummary.trim() !== '';

      // Handoff is needed unless Python already finished the work end-to-end.
      const needHandoff = !(hasTranscript && hasAutoSummary);

      // We pull the raw upload locally if any local-CPU stage still has work.
      // For a hand-off-only retry (video+audio already in S3), we still need
      // a local mp3 to POST to Python, so we extract from raw — cheaper than
      // downloading the existing audioKey because raw is needed for transcode
      // anyway in the most common (full) run.
      const needRaw = !hasMp4 || !hasAudio || needHandoff;
      if (needRaw) {
        await this.storage.downloadToFile(recording.rawKey, rawFile);
        await this.tasks.appendLog(
          task.id,
          makeLogEntry('info', 'download', 'raw webm downloaded'),
        );
      }

      // ── Stage: TRANSCODE webm → mp4 ─────────────────────────────
      if (!hasMp4) {
        await this.tasks.updateStatus(task.id, 'TRANSCODING');
        await this.media.transcodeToMp4(rawFile, mp4File);
        const duration = await this.media.probeDurationSec(mp4File);

        const playbackKey = `processed/${recording.sessionId}/playback.mp4`;
        const sizeBytes = await this.storage.putObjectFromFile(
          playbackKey,
          mp4File,
          'video/mp4',
        );

        // Thumbnail is optional — never fail the pipeline if ffmpeg
        // can't extract a frame at the chosen offset.
        await this.tasks.updateStatus(task.id, 'THUMBNAIL');
        let thumbnailKey: string | null = null;
        const thumbAt = duration > 0 ? Math.min(5, duration * 0.1) : 0;
        try {
          await this.media.extractThumbnailJpeg(mp4File, thumbFile, thumbAt);
          thumbnailKey = `processed/${recording.sessionId}/thumb.jpg`;
          await this.storage.putObjectFromFile(
            thumbnailKey,
            thumbFile,
            'image/jpeg',
          );
        } catch (e) {
          await this.tasks.appendLog(
            task.id,
            makeLogEntry('warn', 'thumbnail', String((e as Error)?.message ?? e)),
          );
        }

        await this.recordings.markVideoReady(recording.id, {
          playbackKey,
          thumbnailKey,
          durationSec: duration,
          sizeBytes: BigInt(sizeBytes),
        });
      } else {
        await this.tasks.appendLog(
          task.id,
          makeLogEntry('info', 'transcode', 'mp4 already exists — skipped'),
        );
      }

      // ── Stage: EXTRACT mp3 ──────────────────────────────────────
      // Always extract when needHandoff (we need the file for the upload).
      // Upload to S3 only when the recording doesn't already have audioKey.
      if (needHandoff) {
        await this.tasks.updateStatus(task.id, 'EXTRACTING_AUDIO');
        await this.media.extractAudioMp3(rawFile, mp3File);

        if (!hasAudio) {
          await this.tasks.updateStatus(task.id, 'UPLOADING_AUDIO');
          const audioKey = `processed/${recording.sessionId}/audio.mp3`;
          await this.storage.putObjectFromFile(audioKey, mp3File, 'audio/mpeg');
          await this.recordings.setAudioKey(recording.id, audioKey);
        }
      }

      // ── Done? ───────────────────────────────────────────────────
      if (!needHandoff) {
        await this.tasks.appendLog(
          task.id,
          makeLogEntry(
            'info',
            'handoff',
            'transcript + autoSummary present — marking complete without handoff',
          ),
        );
        await this.tasks.markCompleted(task.id);
        return;
      }

      // ── Stage: HANDED_OFF — Python takes over ───────────────────
      // Pull is the default. Push only when an admin clicks "Manual retry"
      // on the tasks UI — the retry endpoint writes `{transport: 'push'}`
      // into the task payload so the next run uses push.
      const payload = (task.payload as { transport?: 'push' | 'pull' } | null) ?? {};
      const mode: 'pull' | 'push' = payload.transport === 'push' ? 'push' : 'pull';
      await this.tasks.updateStatus(task.id, 'HANDED_OFF');
      await this.tasks.appendLog(
        task.id,
        makeLogEntry(
          'info',
          'handoff',
          `sending audio to whisper-server (transport=${mode})`,
        ),
      );
      const audioKey = recording.audioKey ?? `processed/${recording.sessionId}/audio.mp3`;
      await this.whisper.enqueueTranscription({
        taskId: task.id,
        mode,
        // pull
        bucket: process.env.S3_BUCKET ?? undefined,
        key: audioKey,
        // push fallback — the local mp3 is in tmp because we extracted it above
        audioFile: mp3File,
      });
      // Release the lock so Python can update the row freely. Status
      // stays at HANDED_OFF; Python moves it through TRANSCRIBING →
      // SUMMARIZING → COMPLETED via direct DB writes.
      await this.tasks.releaseLock(task.id);
    } finally {
      await tmp.cleanup();
    }
  }
}
