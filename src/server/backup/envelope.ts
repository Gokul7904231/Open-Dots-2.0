import {
  BACKUP_FORMAT_VERSION,
  BACKUP_MAGIC,
  backupIdSchema,
  dotIdSchema,
  type BackupEnvelope,
  type BackupType,
} from './types.js';

export function buildBackupKey(
  dotId: string,
  backupType: BackupType,
  backupId: string,
): string {
  dotIdSchema.parse(dotId);
  backupIdSchema.parse(backupId);

  // Strict check against path traversal or escape characters
  if (
    dotId.includes('..') ||
    dotId.includes('/') ||
    dotId.includes('\\') ||
    dotId.includes('\0') ||
    backupId.includes('..') ||
    backupId.includes('/') ||
    backupId.includes('\\') ||
    backupId.includes('\0')
  ) {
    throw new Error('Path traversal detected in backup key parameters.');
  }

  return `backups/${dotId}/${backupType}/${backupId}.odbackup`;
}

export function parseBackupKey(
  key: string,
): { dotId: string; backupType: BackupType; backupId: string } | null {
  const match =
    /^backups\/([A-Za-z0-9][A-Za-z0-9_-]{0,63})\/(workspace|browser-profile|full-computer)\/([A-Za-z0-9_-]+)\.odbackup$/.exec(
      key,
    );
  if (!match) return null;
  return {
    dotId: match[1],
    backupType: match[2] as BackupType,
    backupId: match[3],
  };
}

/**
 * Packs a BackupEnvelope and ciphertext into a self-contained binary payload.
 *
 * Wire format:
 * [4 bytes magic 'ODBK']
 * [4 bytes formatVersion uint32BE]
 * [4 bytes headerLength uint32BE]
 * [headerLength bytes JSON envelope]
 * [ciphertext bytes]
 */
export function packBackup(
  envelope: BackupEnvelope,
  ciphertext: Buffer,
): Buffer {
  const headerJson = Buffer.from(JSON.stringify(envelope), 'utf8');
  const headerLen = headerJson.length;

  const header = Buffer.alloc(12);
  BACKUP_MAGIC.copy(header, 0); // 0..3: 'ODBK'
  header.writeUInt32BE(envelope.formatVersion, 4); // 4..7: formatVersion
  header.writeUInt32BE(headerLen, 8); // 8..11: header length

  return Buffer.concat([header, headerJson, ciphertext]);
}

/**
 * Unpacks and validates a binary backup payload.
 */
export function unpackBackup(packed: Buffer): {
  envelope: BackupEnvelope;
  ciphertext: Buffer;
} {
  if (packed.length < 12) {
    throw new Error(
      'Corrupt backup: payload is smaller than minimal 12-byte header.',
    );
  }

  const magic = packed.subarray(0, 4);
  if (!magic.equals(BACKUP_MAGIC)) {
    throw new Error(
      `Invalid backup format: expected magic 'ODBK', got '${magic.toString('utf8')}'`,
    );
  }

  const formatVersion = packed.readUInt32BE(4);
  if (formatVersion !== BACKUP_FORMAT_VERSION) {
    throw new Error(
      `Unsupported backup format version: ${formatVersion} (supported: ${BACKUP_FORMAT_VERSION})`,
    );
  }

  const headerLength = packed.readUInt32BE(8);
  if (headerLength <= 0 || 12 + headerLength > packed.length) {
    throw new Error(
      `Corrupt backup header length: header declared ${headerLength} bytes but payload is ${packed.length} bytes.`,
    );
  }

  let envelope: BackupEnvelope;
  try {
    const headerStr = packed.subarray(12, 12 + headerLength).toString('utf8');
    envelope = JSON.parse(headerStr) as BackupEnvelope;
  } catch (error) {
    throw new Error('Failed to parse backup metadata envelope JSON.', {
      cause: error,
    });
  }

  // Validate envelope fields
  dotIdSchema.parse(envelope.dotId);
  backupIdSchema.parse(envelope.backupId);

  if (envelope.encryption?.algorithm !== 'aes-256-gcm') {
    throw new Error(
      `Unsupported encryption algorithm: ${envelope.encryption?.algorithm}`,
    );
  }
  if (!envelope.encryption?.ivHex || !envelope.encryption?.authTagHex) {
    throw new Error('Missing encryption IV or authentication tag in envelope.');
  }

  const ciphertext = packed.subarray(12 + headerLength);
  return { envelope, ciphertext };
}
