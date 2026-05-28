/**
 * Hand-off port to the Python whisper-server.
 *
 * Two transports:
 *   - 'pull' (default): the gateway sends a small JSON `{task_id, bucket,
 *     key}` payload and the whisper-server fetches the mp3 from S3 itself.
 *     Cheap handoff, idempotent on retry — preferred for everything.
 *   - 'push' (manual fallback): the gateway uploads the mp3 file in the
 *     request body. Used only when an admin clicks "Manual retry" on the
 *     tasks UI — typically when MinIO is unreachable from whisper-server
 *     and pull-mode failed.
 */

export type EnqueueTranscriptionInput = {
  taskId: string;
  language?: string;
  /** Required for pull mode. */
  bucket?: string;
  key?: string;
  /** Required for push mode — local filesystem path. */
  audioFile?: string;
  /** Default 'pull'. */
  mode?: 'pull' | 'push';
};

export interface WhisperGateway {
  /**
   * Hand off the task to whisper-server. Resolves once the server returns
   * 202 (file fetched / buffered, BackgroundTask scheduled). Status
   * updates flow through Postgres after that — Node never polls.
   */
  enqueueTranscription(input: EnqueueTranscriptionInput): Promise<void>;
}
