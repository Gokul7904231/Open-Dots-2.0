import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from 'node:crypto';

export const GCM_IV_LENGTH_BYTES = 12; // 96-bit nonce recommended for AES-GCM
export const GCM_TAG_LENGTH_BYTES = 16; // 128-bit authentication tag
export const KEY_LENGTH_BYTES = 32; // 256-bit AES key

/**
 * Resolves and validates the backup encryption key from the environment.
 *
 * Rules:
 * - Must be explicitly configured; never randomly generated on application startup.
 *   Losing the key is a recovery failure, not an empty backup.
 * - Must not be the B2 application key.
 * - Must provide 256 bits of key material (32 bytes).
 */
export function resolveEncryptionKey(
  env: Record<string, string | undefined> = process.env,
): Buffer {
  const raw = env.OPENDOTS_BACKUP_ENCRYPTION_KEY?.trim();
  if (!raw) {
    throw new Error(
      'OPENDOTS_BACKUP_ENCRYPTION_KEY is required for durable backups. Configure a 32-byte key.',
    );
  }

  // Check against B2 application key reuse
  const b2AppKey = env.B2_APPLICATION_KEY?.trim();
  if (b2AppKey && raw === b2AppKey) {
    throw new Error(
      'Security violation: OPENDOTS_BACKUP_ENCRYPTION_KEY must not reuse the B2_APPLICATION_KEY.',
    );
  }

  // Support 64-character hex encoding (32 bytes)
  if (/^[0-9a-fA-F]{64}$/.test(raw)) {
    return Buffer.from(raw, 'hex');
  }

  // Support 44-character base64 encoding (32 bytes)
  if (/^[A-Za-z0-9+/]{43}=$/.test(raw)) {
    const buf = Buffer.from(raw, 'base64');
    if (buf.length === KEY_LENGTH_BYTES) return buf;
  }

  // If raw utf-8 string, require at least 32 characters
  const rawBuf = Buffer.from(raw, 'utf8');
  if (rawBuf.length < KEY_LENGTH_BYTES) {
    throw new Error(
      `OPENDOTS_BACKUP_ENCRYPTION_KEY is too short (${rawBuf.length} bytes). At least 32 bytes (or 64 hex characters) required.`,
    );
  }

  // Derive stable 32-byte key using SHA-256 if longer passphrase supplied
  if (rawBuf.length === KEY_LENGTH_BYTES) {
    return rawBuf;
  }
  return createHash('sha256').update(rawBuf).digest();
}

export function computeSha256(data: Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}

export interface EncryptedResult {
  ciphertext: Buffer;
  iv: Buffer;
  authTag: Buffer;
  unencryptedSha256: string;
  encryptedSha256: string;
}

export function encryptPayload(
  plaintext: Buffer,
  key: Buffer,
): EncryptedResult {
  if (key.length !== KEY_LENGTH_BYTES) {
    throw new Error(
      `Encryption key must be ${KEY_LENGTH_BYTES} bytes, got ${key.length}`,
    );
  }

  const unencryptedSha256 = computeSha256(plaintext);
  const iv = randomBytes(GCM_IV_LENGTH_BYTES);
  const cipher = createCipheriv('aes-256-gcm', key, iv);

  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const authTag = cipher.getAuthTag();
  const encryptedSha256 = computeSha256(ciphertext);

  return {
    ciphertext,
    iv,
    authTag,
    unencryptedSha256,
    encryptedSha256,
  };
}

export function decryptPayload(
  ciphertext: Buffer,
  key: Buffer,
  iv: Buffer,
  authTag: Buffer,
  expectedEncryptedSha256?: string,
  expectedUnencryptedSha256?: string,
): Buffer {
  if (key.length !== KEY_LENGTH_BYTES) {
    throw new Error(
      `Decryption key must be ${KEY_LENGTH_BYTES} bytes, got ${key.length}`,
    );
  }
  if (iv.length !== GCM_IV_LENGTH_BYTES) {
    throw new Error(
      `Invalid IV length: expected ${GCM_IV_LENGTH_BYTES} bytes, got ${iv.length}`,
    );
  }
  if (authTag.length !== GCM_TAG_LENGTH_BYTES) {
    throw new Error(
      `Invalid auth tag length: expected ${GCM_TAG_LENGTH_BYTES} bytes, got ${authTag.length}`,
    );
  }

  // Pre-decryption ciphertext integrity check
  if (expectedEncryptedSha256) {
    const actualEncryptedSha256 = computeSha256(ciphertext);
    if (actualEncryptedSha256 !== expectedEncryptedSha256) {
      throw new Error(
        `Ciphertext integrity check failed: expected SHA-256 ${expectedEncryptedSha256}, got ${actualEncryptedSha256}`,
      );
    }
  }

  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(authTag);

  let plaintext: Buffer;
  try {
    plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  } catch (error) {
    throw new Error(
      'Backup decryption/authentication failed: invalid authentication tag, corrupted payload, or incorrect key.',
      { cause: error },
    );
  }

  // Post-decryption plaintext integrity check
  if (expectedUnencryptedSha256) {
    const actualUnencryptedSha256 = computeSha256(plaintext);
    if (actualUnencryptedSha256 !== expectedUnencryptedSha256) {
      throw new Error(
        `Plaintext integrity verification failed: expected SHA-256 ${expectedUnencryptedSha256}, got ${actualUnencryptedSha256}`,
      );
    }
  }

  return plaintext;
}
