import { randomBytes } from 'node:crypto';
import {
  decryptOdarStreamV2,
  encryptOdarStreamV2,
  type OdarStreamV2Identity,
} from './odar-stream-v2.js';
import {
  decryptPayload,
  encryptPayload,
  resolveEncryptionKey,
} from './crypto.js';
import { buildBackupKey, packBackup, unpackBackup } from './envelope.js';
import {
  BACKUP_FORMAT_VERSION,
  type BackupEnvelope,
  type BackupMetadata,
  type BackupType,
  type StorageAdapter,
} from './types.js';

export interface CreateBackupOptions {
  dotId: string;
  backupType: BackupType;
  plaintext: Buffer;
  archiveFormat?: 'tar' | 'raw' | 'json';
  computerImage?: string;
  signal?: AbortSignal;
}

export interface RestoredBackup {
  envelope: BackupEnvelope;
  plaintext: Buffer;
}

/**
 * The source must already be an incremental gzip-compressed tar stream. V2 deliberately
 * does not accept a complete Buffer or build an archive in memory.
 */
export interface CreateStreamingBackupOptions {
  dotId: string;
  backupType: BackupType;
  source: AsyncIterable<Uint8Array>;
  signal?: AbortSignal;
}

export interface StreamingBackupReceipt {
  formatVersion: 2;
  dotId: string;
  backupId: string;
  createdAt: number;
  backupType: BackupType;
  key: string;
  eTag?: string;
  versionId?: string;
}

/**
 * Implementations must write only to isolated staging. commit() may be called
 * only after all chunks are written and validate() succeeds; rollback() must
 * never alter the pre-restore live state.
 */
export interface StreamingRestoreStage<TResult> {
  write(chunk: Uint8Array): Promise<void>;
  validate(): Promise<void>;
  commit(): Promise<TResult>;
  rollback(): Promise<void>;
}

export interface RestoreStreamingBackupOptions<TResult> {
  dotId: string;
  backupId: string;
  backupType: BackupType;
  createStage: () => Promise<StreamingRestoreStage<TResult>>;
  signal?: AbortSignal;
}

export class BackupService {
  constructor(
    private storage: StorageAdapter,
    private encryptionKey?: Buffer,
  ) {}

  private getKey(): Buffer {
    if (this.encryptionKey) return this.encryptionKey;
    return resolveEncryptionKey();
  }

  /**
   * Creates an encrypted, authenticated, versioned backup and uploads it to storage.
   */
  async createBackup(options: CreateBackupOptions): Promise<BackupEnvelope> {
    const { dotId, backupType, plaintext, signal } = options;
    const backupId = randomBytes(16).toString('hex'); // 32-char unique hex ID
    const key = this.getKey();

    // 1. Encrypt payload
    const encrypted = encryptPayload(plaintext, key);

    // 2. Build versioned envelope
    const envelope: BackupEnvelope = {
      formatVersion: BACKUP_FORMAT_VERSION,
      dotId,
      backupId,
      createdAt: Date.now(),
      backupType,
      encryption: {
        algorithm: 'aes-256-gcm',
        ivHex: encrypted.iv.toString('hex'),
        authTagHex: encrypted.authTag.toString('hex'),
      },
      integrity: {
        unencryptedSha256: encrypted.unencryptedSha256,
        encryptedSha256: encrypted.encryptedSha256,
        byteLength: plaintext.length,
      },
      compatibility: {
        computerImage: options.computerImage ?? 'opendots-computer:b6932d3',
        archiveFormat: options.archiveFormat ?? 'json',
      },
    };

    // 3. Pack binary envelope
    const packed = packBackup(envelope, encrypted.ciphertext);

    // 4. Safe object key construction
    const objectKey = buildBackupKey(dotId, backupType, backupId);

    // 5. Store in storage adapter with object metadata
    await this.storage.writeBackup(
      objectKey,
      packed,
      {
        'backup-version': String(BACKUP_FORMAT_VERSION),
        'dot-id': dotId,
        'backup-id': backupId,
        'backup-type': backupType,
        'created-at': String(envelope.createdAt),
        'unencrypted-sha256': encrypted.unencryptedSha256,
        'encrypted-sha256': encrypted.encryptedSha256,
      },
      signal,
    );

    return envelope;
  }

  /**
   * Creates an opt-in ODAR-Stream v2 backup. The supplied source must be an
   * incremental gzip-compressed tar stream; storage must support bounded stream uploads.
   * Existing V1 createBackup() is intentionally unchanged.
   */
  async createStreamingBackup(
    options: CreateStreamingBackupOptions,
  ): Promise<StreamingBackupReceipt> {
    if (!this.storage.writeBackupStream) {
      throw new Error(
        'The configured storage adapter does not support streaming backups.',
      );
    }
    if (
      !['workspace', 'browser-profile', 'full-computer'].includes(
        options.backupType,
      )
    ) {
      throw new Error('Unsupported streaming backup type.');
    }

    const backupId = randomBytes(16).toString('hex');
    const createdAt = Date.now();
    const objectKey = buildBackupKey(
      options.dotId,
      options.backupType,
      backupId,
    );
    const identity: OdarStreamV2Identity = {
      dotId: options.dotId,
      backupId,
      archiveType: options.backupType,
    };
    const encryptedStream = encryptOdarStreamV2(
      options.source,
      this.getKey(),
      identity,
      { signal: options.signal },
    );
    const stored = await this.storage.writeBackupStream(
      objectKey,
      encryptedStream,
      {
        'backup-version': '2',
        'backup-format': 'odar-stream-v2',
        'dot-id': options.dotId,
        'backup-id': backupId,
        'backup-type': options.backupType,
        'created-at': String(createdAt),
      },
      options.signal,
    );

    return {
      formatVersion: 2,
      dotId: options.dotId,
      backupId,
      createdAt,
      backupType: options.backupType,
      key: stored.key,
      eTag: stored.eTag,
      versionId: stored.versionId,
    };
  }

  /**
   * Restores a V2 stream through a caller-provided transaction stage. The
   * decoder yields authenticated frames to staging, then validates the final
   * manifest and EOF before archive validation or commit. V1 restore remains
   * in restoreBackup() and is not silently routed through this decoder.
   */
  async restoreStreamingBackup<TResult>(
    options: RestoreStreamingBackupOptions<TResult>,
  ): Promise<TResult> {
    if (!this.storage.readBackupStream) {
      throw new Error(
        'The configured storage adapter does not support streaming restores.',
      );
    }
    if (
      !['workspace', 'browser-profile', 'full-computer'].includes(
        options.backupType,
      )
    ) {
      throw new Error('Unsupported streaming backup type.');
    }

    const objectKey = buildBackupKey(
      options.dotId,
      options.backupType,
      options.backupId,
    );
    const stored = await this.storage.readBackupStream(
      objectKey,
      options.signal,
    );
    const metadata = stored.metadata ?? {};
    const identityMetadataMatches =
      metadata['backup-version'] === '2' &&
      metadata['backup-format'] === 'odar-stream-v2' &&
      metadata['dot-id'] === options.dotId &&
      metadata['backup-id'] === options.backupId &&
      metadata['backup-type'] === options.backupType;
    if (!identityMetadataMatches) {
      await stored.cancel?.();
      throw new Error(
        'Requested ODAR-Stream v2 restore, but storage metadata does not match the requested V2 backup identity.',
      );
    }

    const stage = await options.createStage();
    const identity: OdarStreamV2Identity = {
      dotId: options.dotId,
      backupId: options.backupId,
      archiveType: options.backupType,
    };

    try {
      const plaintext = decryptOdarStreamV2(
        stored.stream,
        this.getKey(),
        identity,
        { signal: options.signal },
      );
      for await (const chunk of plaintext) {
        if (options.signal?.aborted) {
          throw new Error('ODAR-Stream v2 restore was cancelled.');
        }
        await stage.write(chunk);
      }
      await stage.validate();
      return await stage.commit();
    } catch (error) {
      try {
        await stage.rollback();
      } catch {
        throw new Error(
          'ODAR-Stream v2 restore failed and staging rollback needs operator review.',
          { cause: error },
        );
      }
      throw error;
    }
  }

  /**
   * Restores, validates, authenticates, and decrypts a backup.
   *
   * Verifies:
   * - Backup exists and matches exact requested dotId and backupId
   * - Binary envelope integrity and magic bytes
   * - Ciphertext SHA-256 integrity
   * - AES-256-GCM authentication tag
   * - Plaintext SHA-256 integrity
   */
  async restoreBackup(
    dotId: string,
    backupId: string,
    backupType: BackupType,
    signal?: AbortSignal,
  ): Promise<RestoredBackup> {
    const objectKey = buildBackupKey(dotId, backupType, backupId);
    const { data: packed } = await this.storage.readBackup(objectKey, signal);

    // 1. Unpack envelope and ciphertext
    const { envelope, ciphertext } = unpackBackup(packed);

    // 2. Enforce strict identity matching
    if (envelope.dotId !== dotId) {
      throw new Error(
        `Backup identity mismatch: requested Dot "${dotId}", but backup envelope belongs to "${envelope.dotId}".`,
      );
    }
    if (envelope.backupId !== backupId) {
      throw new Error(
        `Backup ID mismatch: requested "${backupId}", but backup envelope contains "${envelope.backupId}".`,
      );
    }

    const key = this.getKey();
    const iv = Buffer.from(envelope.encryption.ivHex, 'hex');
    const authTag = Buffer.from(envelope.encryption.authTagHex, 'hex');

    // 3. Authenticate and decrypt with cryptographic integrity verification
    const plaintext = decryptPayload(
      ciphertext,
      key,
      iv,
      authTag,
      envelope.integrity.encryptedSha256,
      envelope.integrity.unencryptedSha256,
    );

    return { envelope, plaintext };
  }

  /**
   * Inspects backup metadata without downloading or decrypting the entire payload.
   */
  async getBackupMetadata(
    dotId: string,
    backupId: string,
    backupType: BackupType,
    signal?: AbortSignal,
  ): Promise<BackupMetadata | null> {
    const objectKey = buildBackupKey(dotId, backupType, backupId);
    return this.storage.getMetadata(objectKey, signal);
  }

  /**
   * Deletes a specific backup object.
   */
  async deleteBackup(
    dotId: string,
    backupId: string,
    backupType: BackupType,
    signal?: AbortSignal,
  ): Promise<void> {
    const objectKey = buildBackupKey(dotId, backupType, backupId);
    await this.storage.deleteBackup(objectKey, signal);
  }

  /**
   * Lists backups scoped strictly to a single Dot to ensure tenant isolation.
   */
  async listDotBackups(
    dotId: string,
    backupType?: BackupType,
    signal?: AbortSignal,
  ): Promise<
    Array<{
      backupId: string;
      backupType: BackupType;
      key: string;
      size: number;
      lastModified: Date;
    }>
  > {
    const prefix = backupType
      ? `backups/${dotId}/${backupType}/`
      : `backups/${dotId}/`;

    const items = await this.storage.listBackups(prefix, signal);
    const results: Array<{
      backupId: string;
      backupType: BackupType;
      key: string;
      size: number;
      lastModified: Date;
    }> = [];

    for (const item of items) {
      const match = /^backups\/([^/]+)\/([^/]+)\/([^/.]+)\.odbackup$/.exec(
        item.key,
      );
      if (match && match[1] === dotId) {
        results.push({
          backupId: match[3],
          backupType: match[2] as BackupType,
          key: item.key,
          size: item.size,
          lastModified: item.lastModified,
        });
      }
    }

    return results;
  }
}
