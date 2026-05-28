/**
 * Object storage abstraction (S3 / MinIO). Use-cases must depend on this
 * port, not on aws-sdk directly.
 *
 * Multipart upload helpers are kept here because the recording-init flow
 * needs them; they're tightly coupled to the storage backend.
 */

export type MultipartPart = {
  PartNumber: number;
  ETag: string;
};

export interface StorageGateway {
  /** Upload a local file to `key` with given content type. Returns size. */
  putObjectFromFile(
    key: string,
    file: string,
    contentType: string,
  ): Promise<number>;

  /** Stream-download `key` to a local file path. */
  downloadToFile(key: string, file: string): Promise<void>;

  /** Generate a time-limited GET URL the browser can use directly. */
  presignGet(key: string, expiresInSec?: number): Promise<string>;

  /** Generate a time-limited PUT URL for a single-shot upload. */
  presignPut(
    key: string,
    contentType: string,
    expiresInSec?: number,
  ): Promise<string>;

  delete(key: string): Promise<void>;

  // ---- multipart helpers (used by recordings.routes upload init) ----
  createMultipart(key: string, contentType: string): Promise<string>;
  presignUploadPart(
    key: string,
    uploadId: string,
    partNumber: number,
  ): Promise<string>;
  completeMultipart(
    key: string,
    uploadId: string,
    parts: MultipartPart[],
  ): Promise<void>;
  abortMultipart(key: string, uploadId: string): Promise<void>;
}
