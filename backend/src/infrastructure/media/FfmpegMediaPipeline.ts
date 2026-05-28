import fs from 'node:fs';
import { execSync } from 'node:child_process';
import ffmpeg from 'fluent-ffmpeg';
import ffmpegPath from 'ffmpeg-static';
import ffprobeStatic from 'ffprobe-static';
import type {
  MediaPipeline,
  ProgressCallback,
} from '../../domain/ports/MediaPipeline.js';
import { logger } from '../../lib/logger.js';

function resolveBinary(staticPath: string | null | undefined, name: string): string {
  const envKey = name === 'ffmpeg' ? 'FFMPEG_PATH' : 'FFPROBE_PATH';
  const fromEnv = process.env[envKey];
  if (fromEnv && fs.existsSync(fromEnv)) return fromEnv;
  if (staticPath && fs.existsSync(staticPath)) return staticPath;
  try {
    const sys = execSync(`command -v ${name}`, { stdio: ['ignore', 'pipe', 'ignore'] })
      .toString()
      .trim();
    if (sys && fs.existsSync(sys)) return sys;
  } catch {}
  throw new Error(`${name} not found — install system ${name} or run "pnpm approve-builds"`);
}

const ffmpegBin = resolveBinary(ffmpegPath as unknown as string, 'ffmpeg');
const ffprobeBin = resolveBinary(ffprobeStatic?.path, 'ffprobe');
ffmpeg.setFfmpegPath(ffmpegBin);
ffmpeg.setFfprobePath(ffprobeBin);

export class FfmpegMediaPipeline implements MediaPipeline {
  async transcodeToMp4(
    input: string,
    output: string,
    onProgress?: ProgressCallback,
  ): Promise<void> {
    try {
      await this.runTranscode(input, output, true, onProgress);
    } catch (e: unknown) {
      logger.warn(
        { err: (e as Error)?.message },
        'primary transcode failed, falling back to simple',
      );
      await this.runTranscode(input, output, false, onProgress);
    }
  }

  /**
   * `withScale=true` adds the standard 1080p-cap scale filter; the simple
   * fallback drops it for inputs whose dimensions confuse ffmpeg.
   */
  private runTranscode(
    input: string,
    output: string,
    withScale: boolean,
    onProgress?: ProgressCallback,
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      const stderrChunks: string[] = [];
      let lastProgressLog = 0;
      const cmd = ffmpeg(input)
        .inputOptions(['-fflags', '+genpts'])
        .videoCodec('libx264')
        .audioCodec('aac')
        .outputOptions([
          '-map', '0:v:0',
          '-map', '0:a:0?',
          '-preset', process.env.FFMPEG_PRESET ?? 'ultrafast',
          '-crf', process.env.FFMPEG_CRF ?? '28',
          '-r', '30',
          '-vsync', 'cfr',
          ...(withScale
            ? ['-vf', "scale='trunc(min(iw\\,1920)/2)*2':'trunc(min(ih\\,1080)/2)*2'"]
            : []),
          '-g', '60',
          '-af', 'highpass=f=80,loudnorm=I=-16:TP=-1.5:LRA=11,aresample=async=1000',
          '-movflags', '+faststart',
          '-b:a', '160k',
          '-ar', '48000',
          '-ac', '1',
          '-pix_fmt', 'yuv420p',
          '-max_muxing_queue_size', '1024',
          '-threads', '0',
        ])
        .on('start', (line) => logger.info({ cmd: line }, 'ffmpeg start'))
        .on('progress', (p) => {
          const now = Date.now();
          if (now - lastProgressLog > 5000) {
            lastProgressLog = now;
            logger.info(
              {
                timemark: p.timemark,
                fps: p.currentFps,
                percent: p.percent?.toFixed(1),
              },
              'ffmpeg progress',
            );
          }
          if (onProgress) {
            onProgress({
              fraction: typeof p.percent === 'number' ? p.percent / 100 : undefined,
              timemark: p.timemark,
            });
          }
        })
        .on('stderr', (line) => {
          stderrChunks.push(line);
          if (stderrChunks.length > 40) stderrChunks.shift();
        })
        .on('end', () => resolve())
        .on('error', (err) => {
          const tail = stderrChunks.slice(-8).join(' | ');
          reject(new Error(`${err.message}${tail ? ` :: ${tail}` : ''}`));
        })
        .save(output);
      void cmd;
    });
  }

  extractAudioMp3(input: string, output: string): Promise<void> {
    return new Promise((resolve, reject) => {
      ffmpeg(input)
        .noVideo()
        .audioCodec('libmp3lame')
        .audioBitrate('256k')
        .audioChannels(1)
        .audioFrequency(16000)
        .on('end', () => resolve())
        .on('error', reject)
        .save(output);
    });
  }

  extractThumbnailJpeg(input: string, output: string, atSec: number): Promise<void> {
    return new Promise((resolve, reject) => {
      ffmpeg(input)
        .seekInput(Math.max(0, atSec))
        .outputOptions(['-frames:v', '1', '-q:v', '3', '-vf', 'scale=640:-2'])
        .on('end', () => resolve())
        .on('error', reject)
        .save(output);
    });
  }

  probeDurationSec(input: string): Promise<number> {
    return new Promise((resolve) => {
      ffmpeg.ffprobe(input, (err, data) => {
        if (err) {
          logger.warn({ err: err.message, input }, 'ffprobe failed');
          return resolve(0);
        }
        const d = Number(data?.format?.duration ?? 0);
        resolve(Number.isFinite(d) ? Math.round(d) : 0);
      });
    });
  }
}
