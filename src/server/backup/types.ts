import { z } from 'zod';

export type BackupType = 'workspace' | 'browser-profile' | 'full-computer';

export const BACKUP_FORMAT_VERSION = 1;
export const BACKUP_MAGIC = Buffer.from('ODBK'); // OpenDots Backup

export interface BackupEnvelope {
  formatVersion: number;
  dotId: string;
  backupId: string;
  createdAt: number;
  backupType: BackupType;
  encryption: {
    algorithm: 'aes-256-gcm';
    ivHex: string;
    authTagHex: string;
  };
  integrity: {
    unencryptedSha256: string;
    encryptedSha256: string;
    byteLength: number;
  };
  compatibility: {
    computerImage?: string;
    archiveFormat: 'tar' | 'raw' | 'json';
    os?: string;
  };
}

export interface BackupMetadata {
  key: string;
  dotId: string;
  backupId: string;
  backupType: BackupType;
  byteLength: number;
  createdAt: number;
  eTag?: string;
  versionId?: string;
  unencryptedSha256?: string;
  encryptedSha256?: string;
}

export interface BackupStreamReadResult {
  /** Backpressure-aware stream. Consumers must finish iteration to verify EOF. */
  stream: AsyncIterable<Uint8Array>;
  metadata?: Record<string, string>;
  versionId?: string;
  /** Releases the response body and timeout if iteration never starts or ends early. */
  cancel?: () => Promise<void> | void;
}

export interface StorageAdapter {
  /**
   * Optional streaming APIs are introduced alongside the V1 Buffer methods.
   * They remain optional while non-B2/test adapters migrate incrementally.
   */
  writeBackupStream?(
    key: string,
    data: AsyncIterable<Uint8Array>,
    metadata?: Record<string, string>,
    signal?: AbortSignal,
  ): Promise<{ key: string; eTag?: string; versionId?: string }>;

  readBackupStream?(
    key: string,
    signal?: AbortSignal,
  ): Promise<BackupStreamReadResult>;

  writeBackup(
    key: string,
    data: Buffer,
    metadata?: Record<string, string>,
    signal?: AbortSignal,
  ): Promise<{ key: string; eTag?: string; versionId?: string }>;

  readBackup(
    key: string,
    signal?: AbortSignal,
  ): Promise<{
    data: Buffer;
    metadata?: Record<string, string>;
    versionId?: string;
  }>;

  hasBackup(key: string, signal?: AbortSignal): Promise<boolean>;

  getMetadata(
    key: string,
    signal?: AbortSignal,
  ): Promise<BackupMetadata | null>;

  deleteBackup(key: string, signal?: AbortSignal): Promise<void>;

  listBackups(
    prefix?: string,
    signal?: AbortSignal,
  ): Promise<Array<{ key: string; size: number; lastModified: Date }>>;
}

export const dotIdSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(
    /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/,
    'Dot ID must be alphanumeric with hyphen/underscore',
  );

export const backupIdSchema = z
  .string()
  .min(8)
  .max(64)
  .regex(
    /^[A-Za-z0-9_-]+$/,
    'Backup ID must contain only alphanumeric characters, hyphens or underscores',
  );
