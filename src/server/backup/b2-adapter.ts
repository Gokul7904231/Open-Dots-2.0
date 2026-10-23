import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CreateMultipartUploadCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
  UploadPartCommand,
  type S3ClientConfig,
} from '@aws-sdk/client-s3';
import type { BackupMetadata, StorageAdapter } from './types.js';

export interface B2StorageConfig {
  endpoint: string;
  region: string;
  bucket: string;
  keyId: string;
  applicationKey: string;
  timeoutMs?: number;
  maxRetries?: number;
}

const B2_ENDPOINT_REGEX = /^https:\/\/s3\.[a-z0-9-]+\.backblazeb2\.com$/;
const B2_MULTIPART_MIN_PART_BYTES = 5 * 1024 * 1024;
const B2_MAX_MULTIPART_PARTS = 10_000;
const MAX_BACKUP_DOWNLOAD_BYTES = 500 * 1024 * 1024;

class AsyncByteReader {
  private readonly iterator: AsyncIterator<Uint8Array>;
  private current = Buffer.alloc(0);
  private offset = 0;
  private ended = false;

  constructor(source: AsyncIterable<Uint8Array>) {
    this.iterator = source[Symbol.asyncIterator]();
  }

  async readUpTo(
    maxBytes: number,
    signal: AbortSignal,
  ): Promise<Buffer | null> {
    const output = Buffer.allocUnsafe(maxBytes);
    let written = 0;

    while (written < maxBytes) {
      if (signal.aborted) {
        throw new Error('Backup stream upload was cancelled.');
      }
      if (this.offset >= this.current.length) {
        if (this.ended) break;
        const next = await this.iterator.next();
        if (next.done) {
          this.ended = true;
          break;
        }
        if (!(next.value instanceof Uint8Array)) {
          throw new Error('Backup stream yielded a non-binary chunk.');
        }
        this.current = Buffer.isBuffer(next.value)
          ? next.value
          : Buffer.from(
              next.value.buffer,
              next.value.byteOffset,
              next.value.byteLength,
            );
        this.offset = 0;
        if (this.current.length === 0) continue;
      }

      const copyLength = Math.min(
        maxBytes - written,
        this.current.length - this.offset,
      );
      this.current.copy(output, written, this.offset, this.offset + copyLength);
      written += copyLength;
      this.offset += copyLength;
    }

    return written === 0 ? null : output.subarray(0, written);
  }

  async close(): Promise<void> {
    if (!this.ended) {
      this.ended = true;
      await this.iterator.return?.();
    }
  }
}

/**
 * Parses and validates Backblaze B2 S3 storage configuration from environment variables.
 *
 * Checks both standard names and existing repository conventions:
 * - Endpoint: B2_S3_ENDPOINT or B2_ENDPOINT
 * - Region: B2_REGION
 * - Bucket: B2_BUCKET or B2_BUCKET_NAME
 * - Credentials: B2_KEY_ID and B2_APPLICATION_KEY
 */
export function b2ConfigFromEnv(
  env: Record<string, string | undefined> = process.env,
): B2StorageConfig | null {
  let endpoint = (env.B2_S3_ENDPOINT || env.B2_ENDPOINT)?.trim();
  const region = env.B2_REGION?.trim();
  const bucket = (env.B2_BUCKET || env.B2_BUCKET_NAME)?.trim();
  const keyId = env.B2_KEY_ID?.trim();
  const applicationKey = env.B2_APPLICATION_KEY?.trim();

  // If none of the B2 variables are configured, B2 storage is disabled
  if (!endpoint && !region && !bucket && !keyId && !applicationKey) {
    return null;
  }

  if (!endpoint || !region || !bucket || !keyId || !applicationKey) {
    const missing = [
      (!endpoint && 'B2_S3_ENDPOINT (or B2_ENDPOINT)') || null,
      (!region && 'B2_REGION') || null,
      (!bucket && 'B2_BUCKET (or B2_BUCKET_NAME)') || null,
      (!keyId && 'B2_KEY_ID') || null,
      (!applicationKey && 'B2_APPLICATION_KEY') || null,
    ].filter(Boolean);
    throw new Error(
      `Incomplete B2 storage configuration. Missing: ${missing.join(', ')}`,
    );
  }

  // Normalize endpoint URL: ensure https:// prefix and trim trailing slash
  if (!endpoint.startsWith('http://') && !endpoint.startsWith('https://')) {
    endpoint = `https://${endpoint}`;
  }
  endpoint = endpoint.replace(/\/+$/, '');

  if (!B2_ENDPOINT_REGEX.test(endpoint)) {
    throw new Error(
      `Invalid B2 S3 endpoint format: "${endpoint}". Must match https://s3.<region>.backblazeb2.com`,
    );
  }

  return {
    endpoint,
    region,
    bucket,
    keyId,
    applicationKey,
    timeoutMs: Number(env.B2_TIMEOUT_MS) || 30000,
    maxRetries: Number(env.B2_MAX_RETRIES) || 3,
  };
}

export class B2StorageAdapter implements StorageAdapter {
  private client: S3Client;
  private bucket: string;
  private secretsToRedact: string[];
  private defaultTimeoutMs: number;

  constructor(config: B2StorageConfig, customClient?: S3Client) {
    this.bucket = config.bucket;
    this.defaultTimeoutMs = config.timeoutMs ?? 30000;
    this.secretsToRedact = [config.keyId, config.applicationKey].filter(
      Boolean,
    );

    if (customClient) {
      this.client = customClient;
    } else {
      const clientConfig: S3ClientConfig = {
        endpoint: config.endpoint,
        region: config.region,
        credentials: {
          accessKeyId: config.keyId,
          secretAccessKey: config.applicationKey,
        },
        maxAttempts: config.maxRetries ?? 3,
        forcePathStyle: true, // S3-compatible Backblaze B2 supports path-style bucket routing
      };
      this.client = new S3Client(clientConfig);
    }
  }

  private redact(message: string): string {
    let result = message;
    for (const secret of this.secretsToRedact) {
      if (secret && secret.length >= 4) {
        result = result.split(secret).join('[redacted]');
      }
    }
    return result;
  }

  private async executeWithTimeout<T>(
    fn: (signal: AbortSignal) => Promise<T>,
    externalSignal?: AbortSignal,
  ): Promise<T> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.defaultTimeoutMs);
    const combinedSignal = externalSignal
      ? AbortSignal.any([externalSignal, controller.signal])
      : controller.signal;

    try {
      return await fn(combinedSignal);
    } catch (error: unknown) {
      const isAborted = combinedSignal.aborted;
      const rawMessage = error instanceof Error ? error.message : String(error);
      const safeMessage = this.redact(rawMessage);

      if (isAborted) {
        throw new Error(
          `B2 storage operation timed out or was cancelled: ${safeMessage}`,
          {
            cause: error,
          },
        );
      }

      throw new Error(`B2 storage operation failed: ${safeMessage}`, {
        cause: error,
      });
    } finally {
      clearTimeout(timeout);
    }
  }

  /**
   * Bounded streaming upload. The first 5 MiB are buffered only to decide whether
   * a normal PutObject is sufficient. Larger bodies use serial multipart uploads,
   * so each UploadPart completes before more source data is consumed.
   */
  async writeBackupStream(
    key: string,
    data: AsyncIterable<Uint8Array>,
    metadata?: Record<string, string>,
    signal?: AbortSignal,
  ): Promise<{ key: string; eTag?: string; versionId?: string }> {
    return this.executeWithTimeout(async (activeSignal) => {
      const reader = new AsyncByteReader(data);
      let uploadId: string | undefined;

      try {
        const firstPart = await reader.readUpTo(
          B2_MULTIPART_MIN_PART_BYTES,
          activeSignal,
        );

        if (!firstPart || firstPart.length < B2_MULTIPART_MIN_PART_BYTES) {
          const response = await this.client.send(
            new PutObjectCommand({
              Bucket: this.bucket,
              Key: key,
              Body: firstPart ?? Buffer.alloc(0),
              ContentType: 'application/octet-stream',
              Metadata: metadata,
            }),
            { abortSignal: activeSignal },
          );
          return { key, eTag: response.ETag, versionId: response.VersionId };
        }

        const created = await this.client.send(
          new CreateMultipartUploadCommand({
            Bucket: this.bucket,
            Key: key,
            ContentType: 'application/octet-stream',
            Metadata: metadata,
          }),
          { abortSignal: activeSignal },
        );
        if (!created.UploadId) {
          throw new Error('B2 did not return a multipart upload ID.');
        }
        uploadId = created.UploadId;

        const parts: Array<{ ETag: string; PartNumber: number }> = [];
        let partNumber = 1;
        let part: Buffer | null = firstPart;

        while (part) {
          if (partNumber > B2_MAX_MULTIPART_PARTS) {
            throw new Error(
              'Backup exceeds the B2 multipart part-count limit.',
            );
          }
          const uploaded = await this.client.send(
            new UploadPartCommand({
              Bucket: this.bucket,
              Key: key,
              UploadId: uploadId,
              PartNumber: partNumber,
              Body: part,
            }),
            { abortSignal: activeSignal },
          );
          if (!uploaded.ETag) {
            throw new Error(
              `B2 did not return an ETag for multipart part ${partNumber}.`,
            );
          }
          parts.push({ ETag: uploaded.ETag, PartNumber: partNumber });
          partNumber += 1;
          part = await reader.readUpTo(
            B2_MULTIPART_MIN_PART_BYTES,
            activeSignal,
          );
        }

        const completed = await this.client.send(
          new CompleteMultipartUploadCommand({
            Bucket: this.bucket,
            Key: key,
            UploadId: uploadId,
            MultipartUpload: { Parts: parts },
          }),
          { abortSignal: activeSignal },
        );
        uploadId = undefined;
        return { key, eTag: completed.ETag, versionId: completed.VersionId };
      } catch (error) {
        if (uploadId) {
          try {
            await this.client.send(
              new AbortMultipartUploadCommand({
                Bucket: this.bucket,
                Key: key,
                UploadId: uploadId,
              }),
              { abortSignal: AbortSignal.timeout(5000) },
            );
          } catch (abortError) {
            const detail = this.redact(
              abortError instanceof Error
                ? abortError.message
                : String(abortError),
            ).slice(0, 200);
            throw new Error(
              `Multipart abort failed after B2 upload error: ${detail}`,
              { cause: error },
            );
          }
        }
        throw error;
      } finally {
        await reader.close().catch(() => undefined);
      }
    }, signal);
  }

  /**
   * Opens a bounded read stream without accumulating the object in memory.
   * The transfer timeout remains active until the consumer finishes or cancels.
   */
  async readBackupStream(
    key: string,
    signal?: AbortSignal,
  ): Promise<{
    stream: AsyncIterable<Uint8Array>;
    metadata?: Record<string, string>;
    versionId?: string;
  }> {
    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(new Error('B2 streaming read timed out.')),
      this.defaultTimeoutMs,
    );
    const activeSignal = signal
      ? AbortSignal.any([signal, controller.signal])
      : controller.signal;

    let response;
    try {
      response = await this.client.send(
        new GetObjectCommand({ Bucket: this.bucket, Key: key }),
        { abortSignal: activeSignal },
      );
    } catch (error) {
      clearTimeout(timeout);
      const raw = error instanceof Error ? error.message : String(error);
      if (activeSignal.aborted) {
        throw new Error(
          `B2 storage stream read timed out or was cancelled: ${this.redact(raw)}`,
          { cause: error },
        );
      }
      throw new Error(`B2 storage stream read failed: ${this.redact(raw)}`, {
        cause: error,
      });
    }

    if (!response.Body) {
      clearTimeout(timeout);
      throw new Error(`Empty body received for backup object ${key}`);
    }

    type DestroyableAsyncBody = AsyncIterable<Uint8Array> & {
      destroy?: (error?: Error) => void;
    };
    const body = response.Body as unknown as DestroyableAsyncBody;
    const abortBody = () => {
      body.destroy?.(
        activeSignal.reason instanceof Error
          ? activeSignal.reason
          : new Error('B2 streaming read was cancelled.'),
      );
    };
    if (activeSignal.aborted) abortBody();
    else activeSignal.addEventListener('abort', abortBody, { once: true });

    const adapter = this;
    const stream: AsyncIterable<Uint8Array> = {
      async *[Symbol.asyncIterator]() {
        let totalBytes = 0;
        const iterator = body[Symbol.asyncIterator]();
        try {
          for (;;) {
            if (activeSignal.aborted) {
              throw activeSignal.reason instanceof Error
                ? activeSignal.reason
                : new Error('B2 streaming read was cancelled.');
            }
            const next = await iterator.next();
            if (next.done) return;
            if (!(next.value instanceof Uint8Array)) {
              throw new Error('B2 returned a non-binary stream chunk.');
            }
            totalBytes += next.value.byteLength;
            if (totalBytes > MAX_BACKUP_DOWNLOAD_BYTES) {
              throw new Error(
                'Backup object exceeds maximum download limit (500MB).',
              );
            }
            yield next.value;
          }
        } catch (error) {
          const raw = error instanceof Error ? error.message : String(error);
          if (activeSignal.aborted) {
            throw new Error(
              `B2 storage stream read timed out or was cancelled: ${adapter.redact(raw)}`,
              { cause: error },
            );
          }
          throw new Error(
            `B2 storage stream read failed: ${adapter.redact(raw)}`,
            { cause: error },
          );
        } finally {
          activeSignal.removeEventListener('abort', abortBody);
          clearTimeout(timeout);
          if (activeSignal.aborted) abortBody();
          await iterator.return?.();
        }
      },
    };

    return {
      stream,
      metadata: response.Metadata,
      versionId: response.VersionId,
    };
  }

  async writeBackup(
    key: string,
    data: Buffer,
    metadata?: Record<string, string>,
    signal?: AbortSignal,
  ): Promise<{ key: string; eTag?: string; versionId?: string }> {
    return this.executeWithTimeout(async (activeSignal) => {
      const command = new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: data,
        ContentType: 'application/octet-stream',
        Metadata: metadata,
      });

      const response = await this.client.send(command, {
        abortSignal: activeSignal,
      });
      return {
        key,
        eTag: response.ETag,
        versionId: response.VersionId,
      };
    }, signal);
  }

  async readBackup(
    key: string,
    signal?: AbortSignal,
  ): Promise<{
    data: Buffer;
    metadata?: Record<string, string>;
    versionId?: string;
  }> {
    return this.executeWithTimeout(async (activeSignal) => {
      const command = new GetObjectCommand({
        Bucket: this.bucket,
        Key: key,
      });

      const response = await this.client.send(command, {
        abortSignal: activeSignal,
      });
      if (!response.Body) {
        throw new Error(`Empty body received for backup object ${key}`);
      }

      const stream = response.Body as NodeJS.ReadableStream;
      const chunks: Buffer[] = [];
      let totalBytes = 0;
      const MAX_BACKUP_DOWNLOAD_BYTES = 500 * 1024 * 1024; // 500MB safety ceiling

      for await (const chunk of stream) {
        const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        totalBytes += buf.length;
        if (totalBytes > MAX_BACKUP_DOWNLOAD_BYTES) {
          throw new Error(
            `Backup object ${key} exceeds maximum download limit (500MB).`,
          );
        }
        chunks.push(buf);
      }

      return {
        data: Buffer.concat(chunks),
        metadata: response.Metadata,
        versionId: response.VersionId,
      };
    }, signal);
  }

  async hasBackup(key: string, signal?: AbortSignal): Promise<boolean> {
    try {
      await this.executeWithTimeout(async (activeSignal) => {
        const command = new HeadObjectCommand({
          Bucket: this.bucket,
          Key: key,
        });
        await this.client.send(command, { abortSignal: activeSignal });
      }, signal);
      return true;
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error);
      if (
        msg.includes('NotFound') ||
        msg.includes('404') ||
        msg.includes('NoSuchKey')
      ) {
        return false;
      }
      throw error;
    }
  }

  async getMetadata(
    key: string,
    signal?: AbortSignal,
  ): Promise<BackupMetadata | null> {
    try {
      return await this.executeWithTimeout(async (activeSignal) => {
        const command = new HeadObjectCommand({
          Bucket: this.bucket,
          Key: key,
        });
        const res = await this.client.send(command, {
          abortSignal: activeSignal,
        });
        const meta = res.Metadata || {};

        return {
          key,
          dotId: meta['dot-id'] || '',
          backupId: meta['backup-id'] || '',
          backupType:
            (meta['backup-type'] as BackupMetadata['backupType']) ||
            'workspace',
          byteLength: res.ContentLength || 0,
          createdAt: Number(meta['created-at']) || 0,
          eTag: res.ETag,
          versionId: res.VersionId,
          unencryptedSha256: meta['unencrypted-sha256'],
          encryptedSha256: meta['encrypted-sha256'],
        };
      }, signal);
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error);
      if (
        msg.includes('NotFound') ||
        msg.includes('404') ||
        msg.includes('NoSuchKey')
      ) {
        return null;
      }
      throw error;
    }
  }

  /**
   * Deletes a backup object.
   *
   * NOTE ON BUCKET RETENTION AND VERSIONING:
   * When bucket versioning is enabled on Backblaze B2, a standard DeleteObject
   * call creates a Delete Marker. It does NOT permanently purge historical versions.
   * Permanent deletion of prior versions requires explicit VersionId deletion or
   * B2 bucket lifecycle rules configured in Backblaze.
   */
  async deleteBackup(key: string, signal?: AbortSignal): Promise<void> {
    await this.executeWithTimeout(async (activeSignal) => {
      const command = new DeleteObjectCommand({
        Bucket: this.bucket,
        Key: key,
      });
      await this.client.send(command, { abortSignal: activeSignal });
    }, signal);
  }

  async listBackups(
    prefix = 'backups/',
    signal?: AbortSignal,
  ): Promise<Array<{ key: string; size: number; lastModified: Date }>> {
    return this.executeWithTimeout(async (activeSignal) => {
      const command = new ListObjectsV2Command({
        Bucket: this.bucket,
        Prefix: prefix,
      });

      const response = await this.client.send(command, {
        abortSignal: activeSignal,
      });
      const contents = response.Contents || [];

      return contents
        .filter((item): item is typeof item & { Key: string } => !!item.Key)
        .map((item) => ({
          key: item.Key,
          size: item.Size || 0,
          lastModified: item.LastModified || new Date(),
        }));
    }, signal);
  }
}
