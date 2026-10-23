import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
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
