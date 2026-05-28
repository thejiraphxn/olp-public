import {
  S3Client,
  CreateMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  UploadPartCommand,
  AbortMultipartUploadCommand,
  GetObjectCommand,
  PutObjectCommand,
  HeadObjectCommand,
  DeleteObjectsCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { config } from '../../config.js';
import { logger } from '../../lib/logger.js';

const s3 = new S3Client({
  region: config.s3.region,
  endpoint: config.s3.endpoint,
  forcePathStyle: config.s3.forcePathStyle,
  credentials: {
    accessKeyId: config.s3.accessKey,
    secretAccessKey: config.s3.secretKey,
  },
});

const publicS3 = new S3Client({
  region: config.s3.region,
  endpoint: config.s3.publicEndpoint,
  forcePathStyle: config.s3.forcePathStyle,
  credentials: {
    accessKeyId: config.s3.accessKey,
    secretAccessKey: config.s3.secretKey,
  },
});

export const Bucket = config.s3.bucket;

export async function createMultipart(key: string) {
  const res = await s3.send(
    new CreateMultipartUploadCommand({ Bucket, Key: key, ContentType: 'video/webm' }),
  );
  return res.UploadId!;
}

export async function presignUploadPart(key: string, uploadId: string, partNumber: number) {
  const cmd = new UploadPartCommand({
    Bucket,
    Key: key,
    UploadId: uploadId,
    PartNumber: partNumber,
  });
  return getSignedUrl(publicS3, cmd, { expiresIn: 60 * 15 });
}

export async function completeMultipart(
  key: string,
  uploadId: string,
  parts: { PartNumber: number; ETag: string }[],
) {
  await s3.send(
    new CompleteMultipartUploadCommand({
      Bucket,
      Key: key,
      UploadId: uploadId,
      MultipartUpload: { Parts: parts.sort((a, b) => a.PartNumber - b.PartNumber) },
    }),
  );
}

export async function abortMultipart(key: string, uploadId: string) {
  // Best-effort cleanup — the upload may already be gone. Log instead of
  // swallowing so orphaned multiparts (which bill storage) surface in logs.
  await s3
    .send(new AbortMultipartUploadCommand({ Bucket, Key: key, UploadId: uploadId }))
    .catch((err) => logger.warn({ err, key, uploadId }, 'abortMultipart failed'));
}

export async function presignGet(key: string, expiresIn = 60 * 30) {
  return getSignedUrl(publicS3, new GetObjectCommand({ Bucket, Key: key }), { expiresIn });
}

// Same as presignGet but adds Content-Disposition: attachment so the browser
// downloads the object instead of streaming it inline. `filename` is what the
// user's browser will save as — sanitized to ASCII-safe chars to avoid
// header-injection issues with weird unicode.
export async function presignGetDownload(
  key: string,
  filename: string,
  expiresIn = 60 * 30,
) {
  const safe = filename.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 200) || 'download';
  return getSignedUrl(
    publicS3,
    new GetObjectCommand({
      Bucket,
      Key: key,
      ResponseContentDisposition: `attachment; filename="${safe}"`,
    }),
    { expiresIn },
  );
}

export async function presignPut(key: string, contentType: string, expiresIn = 60 * 5) {
  return getSignedUrl(
    publicS3,
    new PutObjectCommand({ Bucket, Key: key, ContentType: contentType }),
    { expiresIn },
  );
}

export async function headObject(key: string) {
  return s3.send(new HeadObjectCommand({ Bucket, Key: key }));
}

// S3 DeleteObjects caps at 1000 keys per request. Chunks + swallows
// per-object errors (already-gone keys) but logs batch-level failures.
export async function deleteObjects(keys: string[]) {
  const unique = Array.from(new Set(keys.filter(Boolean)));
  for (let i = 0; i < unique.length; i += 1000) {
    const batch = unique.slice(i, i + 1000);
    try {
      await s3.send(
        new DeleteObjectsCommand({
          Bucket,
          Delete: { Objects: batch.map((Key) => ({ Key })), Quiet: true },
        }),
      );
    } catch (err) {
      logger.warn({ err, batchSize: batch.length }, 'deleteObjects batch failed');
    }
  }
}

export type RecordingS3Refs = {
  rawKey?: string | null;
  playbackKey?: string | null;
  audioKey?: string | null;
  thumbnailKey?: string | null;
  s3UploadId?: string | null;
};

// Aborts any in-flight multipart upload, then deletes every object the
// recording references. Best-effort: failures are logged, never thrown —
// caller is usually in a destructive path where the DB row has to go away
// regardless of S3 outcome (orphaned bytes are recoverable, orphaned DB
// pointers are not).
export async function cleanupRecordingS3(rec: RecordingS3Refs | null | undefined) {
  if (!rec) return;
  if (rec.rawKey && rec.s3UploadId) {
    await abortMultipart(rec.rawKey, rec.s3UploadId);
  }
  const keys = [rec.rawKey, rec.playbackKey, rec.audioKey, rec.thumbnailKey].filter(
    (k): k is string => !!k,
  );
  if (keys.length > 0) await deleteObjects(keys);
}

export { s3, PutObjectCommand };
