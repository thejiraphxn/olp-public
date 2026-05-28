/**
 * Media-processing port. Production impl is ffmpeg-backed
 * (`infrastructure/media/FfmpegMediaPipeline.ts`).
 *
 * All paths are local filesystem paths the worker controls.
 */

export type ProgressEvent = {
  /** 0..1 fraction; may be undefined if codec doesn't report progress. */
  fraction?: number;
  /** ffmpeg-style timemark string (HH:MM:SS.ms) when available. */
  timemark?: string;
};

export type ProgressCallback = (event: ProgressEvent) => void;

export interface MediaPipeline {
  /**
   * Transcode source (e.g. webm) to mp4 with universal-playback flags
   * (H.264 + AAC, +faststart, yuv420p, CFR, audio loudnorm).
   */
  transcodeToMp4(
    input: string,
    output: string,
    onProgress?: ProgressCallback,
  ): Promise<void>;

  /**
   * Extract audio as a small mp3 (mono 16k 64kbps) — used for whisper
   * upload AND as the downloadable audio artifact.
   */
  extractAudioMp3(input: string, output: string): Promise<void>;

  extractThumbnailJpeg(
    input: string,
    output: string,
    atSec: number,
  ): Promise<void>;

  /** Returns 0 when probing fails. */
  probeDurationSec(input: string): Promise<number>;
}
