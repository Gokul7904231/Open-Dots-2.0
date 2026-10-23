import { randomBytes } from 'node:crypto';
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
