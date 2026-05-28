import fs from 'node:fs';
import { pipeline } from 'node:stream/promises';
import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CreateMultipartUploadCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
  type S3Client,
  UploadPartCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import type {
  MultipartPart,
  StorageGateway,
} from '../../domain/ports/StorageGateway.js';

/**
 * S3-compatible storage adapter (works against MinIO and AWS S3).
 *
 * Two clients are passed in: one for server-side ops (`internal`) and
 * one whose endpoint matches the public hostname (`publicForSigning`).
 * Presigned URLs are signed with the public client so signature includes
 * the public hostname the browser will hit.
 */
export class S3Storage implements StorageGateway {
  constructor(
    private readonly internal: S3Client,
    private readonly publicForSigning: S3Client,
    private readonly bucket: string,
  ) {}

  async putObjectFromFile(
    key: string,
    file: string,
    contentType: string,
  ): Promise<number> {
    const buf = fs.readFileSync(file);
    await this.internal.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: buf,
        ContentType: contentType,
      }),
    );
    return buf.length;
  }

  async downloadToFile(key: string, file: string): Promise<void> {
    const obj = await this.internal.send(
      new GetObjectCommand({ Bucket: this.bucket, Key: key }),
    );
    const body = obj.Body as NodeJS.ReadableStream;
    await pipeline(body, fs.createWriteStream(file));
  }

  async presignGet(key: string, expiresInSec: number = 60 * 30): Promise<string> {
    return getSignedUrl(
      this.publicForSigning,
      new GetObjectCommand({ Bucket: this.bucket, Key: key }),
      { expiresIn: expiresInSec },
    );
  }

  async presignPut(
    key: string,
    contentType: string,
    expiresInSec: number = 60 * 5,
  ): Promise<string> {
    return getSignedUrl(
      this.publicForSigning,
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        ContentType: contentType,
      }),
      { expiresIn: expiresInSec },
    );
  }

  async delete(key: string): Promise<void> {
    await this.internal.send(
      new DeleteObjectCommand({ Bucket: this.bucket, Key: key }),
    );
  }

  async createMultipart(key: string, contentType: string): Promise<string> {
    const res = await this.internal.send(
      new CreateMultipartUploadCommand({
        Bucket: this.bucket,
        Key: key,
        ContentType: contentType,
      }),
    );
    if (!res.UploadId) throw new Error('S3 returned no UploadId');
    return res.UploadId;
  }

  async presignUploadPart(
    key: string,
    uploadId: string,
    partNumber: number,
  ): Promise<string> {
    return getSignedUrl(
      this.publicForSigning,
      new UploadPartCommand({
        Bucket: this.bucket,
        Key: key,
        UploadId: uploadId,
        PartNumber: partNumber,
      }),
      { expiresIn: 60 * 15 },
    );
  }

  async completeMultipart(
    key: string,
    uploadId: string,
    parts: MultipartPart[],
  ): Promise<void> {
    await this.internal.send(
      new CompleteMultipartUploadCommand({
        Bucket: this.bucket,
        Key: key,
        UploadId: uploadId,
        MultipartUpload: {
          Parts: [...parts].sort((a, b) => a.PartNumber - b.PartNumber),
        },
      }),
    );
  }

  async abortMultipart(key: string, uploadId: string): Promise<void> {
    await this.internal.send(
      new AbortMultipartUploadCommand({
        Bucket: this.bucket,
        Key: key,
        UploadId: uploadId,
      }),
    );
  }
}
