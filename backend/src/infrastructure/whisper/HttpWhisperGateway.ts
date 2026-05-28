import fs from 'node:fs';
import path from 'node:path';
import type {
  EnqueueTranscriptionInput,
  WhisperGateway,
} from '../../domain/ports/WhisperGateway.js';
import { logger } from '../../lib/logger.js';

/**
 * Fire-and-forget hand-off to the Python whisper-server.
 *
 * Default transport is **pull**: we POST a small JSON `{task_id, key,
 * bucket}` to `/v1/tasks/from-s3` and the server fetches the mp3 from
 * MinIO itself. The push variant (multipart upload to `/v1/tasks`) stays
 * for the admin "Manual retry" escape hatch.
 *
 * Implementation note: we used to pass a custom undici `Agent` via the
 * `dispatcher` fetch option, but Node 24's global fetch rejects it
 * with `UND_ERR_INVALID_ARG`. The default timeouts (5 min each) are
 * plenty for both modes.
 */
export class HttpWhisperGateway implements WhisperGateway {
  async enqueueTranscription(input: EnqueueTranscriptionInput): Promise<void> {
    // Phase 2: hand-off only goes to the local whisper-server. Cloud
    // providers (Groq, OpenAI) don't expose POST /v1/tasks — they're not
    // valid targets here. Default points at the local FastAPI server
    // reachable via host-gateway from inside the api container.
    const baseUrl = (
      process.env.WHISPER_API_BASE_URL ?? 'http://host.docker.internal:8000/v1'
    ).replace(/\/+$/, '');
    const key = process.env.WHISPER_API_KEY;
    const mode = input.mode ?? 'pull';

    if (mode === 'pull') {
      await this.pull(baseUrl, key, input);
    } else {
      await this.push(baseUrl, key, input);
    }
  }

  private async pull(
    baseUrl: string,
    apiKey: string | undefined,
    input: EnqueueTranscriptionInput,
  ): Promise<void> {
    if (!input.key) {
      throw new Error('pull mode requires `key` (s3 object path)');
    }
    const url = `${baseUrl}/tasks/from-s3`;
    const body = {
      task_id: input.taskId,
      bucket: input.bucket,
      key: input.key,
      ...(input.language ? { language: input.language } : {}),
    };
    logger.info(
      { url, taskId: input.taskId, bucket: input.bucket, key: input.key },
      'whisper handoff (pull) →',
    );
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const txt = await res.text();
      throw new Error(`whisper-server pull ${res.status}: ${txt.slice(0, 300)}`);
    }
    logger.info({ taskId: input.taskId }, 'whisper handoff (pull) ✓');
  }

  private async push(
    baseUrl: string,
    apiKey: string | undefined,
    input: EnqueueTranscriptionInput,
  ): Promise<void> {
    if (!input.audioFile) {
      throw new Error('push mode requires `audioFile` (local mp3 path)');
    }
    const stat = fs.statSync(input.audioFile);
    const url = `${baseUrl}/tasks`;
    const form = new FormData();
    form.append(
      'file',
      new Blob([fs.readFileSync(input.audioFile)], { type: 'audio/mpeg' }),
      path.basename(input.audioFile),
    );
    form.append('task_id', input.taskId);
    if (input.language) form.append('language', input.language);

    logger.info(
      {
        url,
        taskId: input.taskId,
        sizeMB: (stat.size / 1024 / 1024).toFixed(1),
      },
      'whisper handoff (push) →',
    );
    const res = await fetch(url, {
      method: 'POST',
      headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : undefined,
      body: form,
    });
    if (!res.ok) {
      const txt = await res.text();
      throw new Error(`whisper-server push ${res.status}: ${txt.slice(0, 300)}`);
    }
    logger.info({ taskId: input.taskId }, 'whisper handoff (push) ✓');
  }
}
