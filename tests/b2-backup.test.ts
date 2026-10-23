import { gunzipSync, gzipSync } from 'node:zlib';
import { Readable } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import type { S3Client } from '@aws-sdk/client-s3';
import {
  b2ConfigFromEnv,
  B2StorageAdapter,
  resolveEncryptionKey,
  encryptPayload,
  decryptPayload,
  buildBackupKey,
  packBackup,
  unpackBackup,
  assertSafeArchivePath,
  ArchiveBudgetTracker,
  BackupService,
  createArchive,
  type StorageAdapter,
  type BackupMetadata,
  type BackupEnvelope,
} from '../src/server/backup/index.js';
import { ComputerService } from '../src/server/computer-service.js';
import { WorkspaceStore } from '../src/server/workspace.js';
import type { ComputerProvider } from '../src/server/computer-provider.js';

describe('B2 Configuration Validation', () => {
  it('returns null when no B2 configuration is present', () => {
    expect(b2ConfigFromEnv({})).toBeNull();
  });

  it('throws descriptive error listing missing required variables', () => {
    expect(() =>
      b2ConfigFromEnv({
        B2_S3_ENDPOINT: 'https://s3.us-east-005.backblazeb2.com',
      }),
    ).toThrow(
      'Incomplete B2 storage configuration. Missing: B2_REGION, B2_BUCKET',
    );
  });

  it('validates and normalizes endpoint URL (prepends https:// and strips trailing slash)', () => {
    const config = b2ConfigFromEnv({
      B2_ENDPOINT: 's3.us-east-005.backblazeb2.com/',
      B2_REGION: 'us-east-005',
      B2_BUCKET_NAME: 'opendots-persistence-20261021',
      B2_KEY_ID: 'TEST_B2_KEY_ID_NOT_REAL_0001',
      B2_APPLICATION_KEY: 'TEST_B2_APP_KEY_NOT_REAL_ONLY',
    });

    expect(config).not.toBeNull();
    expect(config?.endpoint).toBe('https://s3.us-east-005.backblazeb2.com');
    expect(config?.region).toBe('us-east-005');
    expect(config?.bucket).toBe('opendots-persistence-20261021');
  });

  it('rejects invalid endpoint formats', () => {
    expect(() =>
      b2ConfigFromEnv({
        B2_S3_ENDPOINT: 'https://malicious-endpoint.com',
        B2_REGION: 'us-east-005',
        B2_BUCKET: 'bucket',
        B2_KEY_ID: 'key',
        B2_APPLICATION_KEY: 'secret',
      }),
    ).toThrow('Invalid B2 S3 endpoint format');
  });
});

describe('Encryption Key Resolution & Authenticated AES-256-GCM', () => {
  const validHexKey =
    '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

  it('resolves 64-char hex key to 32 bytes', () => {
    const key = resolveEncryptionKey({
      OPENDOTS_BACKUP_ENCRYPTION_KEY: validHexKey,
    });
    expect(key.length).toBe(32);
    expect(key.toString('hex')).toBe(validHexKey);
  });

  it('rejects missing or empty encryption key', () => {
    expect(() => resolveEncryptionKey({})).toThrow(
      'OPENDOTS_BACKUP_ENCRYPTION_KEY is required',
    );
  });

  it('rejects reuse of B2_APPLICATION_KEY as encryption key', () => {
    expect(() =>
      resolveEncryptionKey({
        B2_APPLICATION_KEY: 'TEST_B2_APP_KEY_NOT_REAL_ONLY',
        OPENDOTS_BACKUP_ENCRYPTION_KEY: 'TEST_B2_APP_KEY_NOT_REAL_ONLY',
      }),
    ).toThrow(
      'Security violation: OPENDOTS_BACKUP_ENCRYPTION_KEY must not reuse',
    );
  });

  it('rejects keys shorter than 32 bytes', () => {
    expect(() =>
      resolveEncryptionKey({
        OPENDOTS_BACKUP_ENCRYPTION_KEY: 'too-short-secret',
      }),
    ).toThrow('too short');
  });

  it('encrypts and decrypts payload identically with distinct nonces per call', () => {
    const key = resolveEncryptionKey({
      OPENDOTS_BACKUP_ENCRYPTION_KEY: validHexKey,
    });
    const plaintext = Buffer.from(
      'Sensitive browser cookies and tokens',
      'utf8',
    );

    const enc1 = encryptPayload(plaintext, key);
    const enc2 = encryptPayload(plaintext, key);

    // Each call must use a unique cryptographic nonce (IV)
    expect(enc1.iv.equals(enc2.iv)).toBe(false);
    expect(enc1.ciphertext.equals(enc2.ciphertext)).toBe(false);

    const decrypted = decryptPayload(
      enc1.ciphertext,
      key,
      enc1.iv,
      enc1.authTag,
      enc1.encryptedSha256,
      enc1.unencryptedSha256,
    );
    expect(decrypted.toString('utf8')).toBe(plaintext.toString('utf8'));
  });

  it('rejects tampered ciphertext and authentication tag', () => {
    const key = resolveEncryptionKey({
      OPENDOTS_BACKUP_ENCRYPTION_KEY: validHexKey,
    });
    const plaintext = Buffer.from('Confidential data', 'utf8');
    const enc = encryptPayload(plaintext, key);

    // Tamper with ciphertext
    const tamperedCiphertext = Buffer.from(enc.ciphertext);
    tamperedCiphertext[0] ^= 0xff;

    expect(() =>
      decryptPayload(
        tamperedCiphertext,
        key,
        enc.iv,
        enc.authTag,
        enc.encryptedSha256,
      ),
    ).toThrow('Ciphertext integrity check failed');

    // Tamper without SHA-256 check to test GCM authTag verification
    expect(() =>
      decryptPayload(tamperedCiphertext, key, enc.iv, enc.authTag),
    ).toThrow('Backup decryption/authentication failed');
  });

  it('rejects decryption with the wrong key', () => {
    const key1 = resolveEncryptionKey({
      OPENDOTS_BACKUP_ENCRYPTION_KEY: validHexKey,
    });
    const key2 = resolveEncryptionKey({
      OPENDOTS_BACKUP_ENCRYPTION_KEY:
        'fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210',
    });

    const plaintext = Buffer.from('Secret data', 'utf8');
    const enc = encryptPayload(plaintext, key1);

    expect(() =>
      decryptPayload(enc.ciphertext, key2, enc.iv, enc.authTag),
    ).toThrow('Backup decryption/authentication failed');
  });
});

describe('Versioned Backup Envelope & Key Construction', () => {
  it('constructs deterministic, isolated object keys', () => {
    const key = buildBackupKey('dot-42', 'workspace', 'backup-abc');
    expect(key).toBe('backups/dot-42/workspace/backup-abc.odbackup');
  });

  it('rejects path traversal in dotId and backupId', () => {
    expect(() => buildBackupKey('../etc', 'workspace', 'abc')).toThrow();
    expect(() => buildBackupKey('dot', 'workspace', '../../escape')).toThrow();
    expect(() => buildBackupKey('dot/sub', 'workspace', 'abc')).toThrow();
    expect(() => buildBackupKey('dot\0null', 'workspace', 'abc')).toThrow();
  });

  it('packs and unpacks versioned binary envelope', () => {
    const envelope: BackupEnvelope = {
      formatVersion: 1,
      dotId: 'dot-1',
      backupId: 'backup-12345678',
      createdAt: 1700000000000,
      backupType: 'browser-profile',
      encryption: {
        algorithm: 'aes-256-gcm',
        ivHex: '0102030405060708090a0b0c',
        authTagHex: '102030405060708090a0b0c0d0e0f000',
      },
      integrity: {
        unencryptedSha256: 'abc',
        encryptedSha256: 'def',
        byteLength: 100,
      },
      compatibility: {
        computerImage: 'opendots-computer:b6932d3',
        archiveFormat: 'tar',
      },
    };

    const ciphertext = Buffer.from('encrypted-bytes');
    const packed = packBackup(envelope, ciphertext);

    const unpacked = unpackBackup(packed);
    expect(unpacked.envelope).toEqual(envelope);
    expect(unpacked.ciphertext.toString('utf8')).toBe('encrypted-bytes');
  });

  it('rejects corrupt magic bytes or unsupported version', () => {
    const badMagic = Buffer.alloc(20);
    badMagic.write('BAD!', 0);
    expect(() => unpackBackup(badMagic)).toThrow("expected magic 'ODBK'");

    const badVersion = Buffer.alloc(20);
    badVersion.write('ODBK', 0);
    badVersion.writeUInt32BE(99, 4);
    expect(() => unpackBackup(badVersion)).toThrow(
      'Unsupported backup format version: 99',
    );
  });
});

describe('Archive Safety & Resource Limits', () => {
  const destDir = 'C:\\temp\\workspace';

  it('accepts safe relative archive paths', () => {
    const safe = assertSafeArchivePath('src/index.js', destDir);
    expect(safe).toContain('src');
    expect(safe).toContain('index.js');
  });

  it('rejects path traversal attacks in archive paths', () => {
    expect(() => assertSafeArchivePath('../../etc/passwd', destDir)).toThrow(
      'Path traversal',
    );
    expect(() => assertSafeArchivePath('/root/secret', destDir)).toThrow(
      'Absolute archive path',
    );
    expect(() =>
      assertSafeArchivePath('C:\\Windows\\system32', destDir),
    ).toThrow('Absolute drive or UNC path');
    expect(() => assertSafeArchivePath('evil\0path', destDir)).toThrow(
      'Null byte detected',
    );
  });

  it('enforces total size and file count limits (zip-bomb defense)', () => {
    const tracker = new ArchiveBudgetTracker({
      maxFiles: 3,
      maxTotalBytes: 1000,
      maxSingleFileBytes: 500,
    });

    tracker.trackFile(200, 'file1.txt');
    tracker.trackFile(300, 'file2.txt');

    expect(() => tracker.trackFile(600, 'file3.txt')).toThrow(
      'exceeds single file size limit',
    );
    expect(() => tracker.trackFile(600, 'file3-small.txt')).toThrow(); // exceeds total bytes
  });
});

describe('B2 Storage Adapter & Secret Redaction', () => {
  it('redacts secret credentials in thrown errors', async () => {
    const keyId = 'TEST_B2_KEY_ID_NOT_REAL_0001';
    const appKey = 'TEST_B2_APP_KEY_NOT_REAL_ONLY';

    const mockClient = {
      send: vi
        .fn()
        .mockRejectedValue(
          new Error(
            `Authorization failed for key ${keyId} with secret ${appKey}`,
          ),
        ),
    } as unknown as S3Client;

    const adapter = new B2StorageAdapter(
      {
        endpoint: 'https://s3.us-east-005.backblazeb2.com',
        region: 'us-east-005',
        bucket: 'test-bucket',
        keyId,
        applicationKey: appKey,
      },
      mockClient,
    );

    await expect(adapter.readBackup('test-key')).rejects.toThrow(
      'B2 storage operation failed: Authorization failed for key [redacted] with secret [redacted]',
    );
  });

  it('handles cancellation and timeout via AbortSignal', async () => {
    const mockClient = {
      send: vi.fn().mockImplementation((_cmd, options) => {
        return new Promise((_resolve, reject) => {
          options?.abortSignal?.addEventListener('abort', () =>
            reject(new Error('Operation cancelled')),
          );
        });
      }),
    } as unknown as S3Client;

    const adapter = new B2StorageAdapter(
      {
        endpoint: 'https://s3.us-east-005.backblazeb2.com',
        region: 'us-east-005',
        bucket: 'test-bucket',
        keyId: 'key',
        applicationKey: 'secret',
        timeoutMs: 50,
      },
      mockClient,
    );

    await expect(adapter.readBackup('slow-object')).rejects.toThrow(
      'timed out or was cancelled',
    );
  });

  it('streams small backups through PutObject', async () => {
    const calls: Array<{ name: string; input: Record<string, unknown> }> = [];
    const mockClient = {
      send: vi.fn(async (command: unknown) => {
        const item = command as {
          constructor: { name: string };
          input: Record<string, unknown>;
        };
        calls.push({ name: item.constructor.name, input: item.input });
        return { ETag: '"small-etag"', VersionId: 'v1' };
      }),
    } as unknown as S3Client;
    const adapter = new B2StorageAdapter(
      {
        endpoint: 'https://s3.us-east-005.backblazeb2.com',
        region: 'us-east-005',
        bucket: 'test-bucket',
        keyId: 'test-key-id',
        applicationKey: 'test-application-key',
      },
      mockClient,
    );

    async function* source() {
      yield Buffer.from('small backup');
    }
    const result = await adapter.writeBackupStream('small.odbackup', source(), {
      'backup-version': '2',
    });

    expect(result).toEqual({
      key: 'small.odbackup',
      eTag: '"small-etag"',
      versionId: 'v1',
    });
    expect(calls.map((call) => call.name)).toEqual(['PutObjectCommand']);
    expect(Buffer.from(calls[0]!.input.Body as Uint8Array).toString()).toBe(
      'small backup',
    );
    expect(calls[0]!.input.Metadata).toEqual({ 'backup-version': '2' });
  });

  it('uses 5 MiB multipart parts and permits a small final part', async () => {
    const partSizes: number[] = [];
    const commandNames: string[] = [];
    const mockClient = {
      send: vi.fn(async (command: unknown) => {
        const item = command as {
          constructor: { name: string };
          input: Record<string, unknown>;
        };
        commandNames.push(item.constructor.name);
        if (item.constructor.name === 'CreateMultipartUploadCommand') {
          return { UploadId: 'upload-1' };
        }
        if (item.constructor.name === 'UploadPartCommand') {
          const body = item.input.Body as Uint8Array;
          partSizes.push(body.byteLength);
          return { ETag: `"part-${String(item.input.PartNumber)}"` };
        }
        if (item.constructor.name === 'CompleteMultipartUploadCommand') {
          return { ETag: '"complete-etag"', VersionId: 'v2' };
        }
        throw new Error(`Unexpected S3 command: ${item.constructor.name}`);
      }),
    } as unknown as S3Client;
    const adapter = new B2StorageAdapter(
      {
        endpoint: 'https://s3.us-east-005.backblazeb2.com',
        region: 'us-east-005',
        bucket: 'test-bucket',
        keyId: 'test-key-id',
        applicationKey: 'test-application-key',
      },
      mockClient,
    );

    async function* source() {
      yield Buffer.alloc(3 * 1024 * 1024, 0x11);
      yield Buffer.alloc(3 * 1024 * 1024, 0x22);
    }
    const result = await adapter.writeBackupStream('large.odbackup', source(), {
      'dot-id': 'dot-alpha',
    });

    expect(result).toEqual({
      key: 'large.odbackup',
      eTag: '"complete-etag"',
      versionId: 'v2',
    });
    expect(partSizes).toEqual([5 * 1024 * 1024, 1 * 1024 * 1024]);
    expect(commandNames).toEqual([
      'CreateMultipartUploadCommand',
      'UploadPartCommand',
      'UploadPartCommand',
      'CompleteMultipartUploadCommand',
    ]);
  });

  it('aborts multipart uploads after a failed part', async () => {
    const commandNames: string[] = [];
    const mockClient = {
      send: vi.fn(async (command: unknown) => {
        const item = command as { constructor: { name: string } };
        commandNames.push(item.constructor.name);
        if (item.constructor.name === 'CreateMultipartUploadCommand') {
          return { UploadId: 'upload-to-abort' };
        }
        if (item.constructor.name === 'UploadPartCommand') {
          throw new Error('injected part failure');
        }
        if (item.constructor.name === 'AbortMultipartUploadCommand') {
          return {};
        }
        throw new Error(`Unexpected S3 command: ${item.constructor.name}`);
      }),
    } as unknown as S3Client;
    const adapter = new B2StorageAdapter(
      {
        endpoint: 'https://s3.us-east-005.backblazeb2.com',
        region: 'us-east-005',
        bucket: 'test-bucket',
        keyId: 'test-key-id',
        applicationKey: 'test-application-key',
      },
      mockClient,
    );

    async function* source() {
      yield Buffer.alloc(5 * 1024 * 1024, 0x33);
      yield Buffer.alloc(10, 0x44);
    }

    await expect(
      adapter.writeBackupStream('aborted.odbackup', source()),
    ).rejects.toThrow('injected part failure');
    expect(commandNames).toEqual([
      'CreateMultipartUploadCommand',
      'UploadPartCommand',
      'AbortMultipartUploadCommand',
    ]);
  });

  it('reads B2 backups as a bounded stream', async () => {
    const mockClient = {
      send: vi.fn(async () => ({
        Body: Readable.from([Buffer.from('first-'), Buffer.from('second')]),
        Metadata: { 'dot-id': 'dot-alpha' },
        VersionId: 'v3',
      })),
    } as unknown as S3Client;
    const adapter = new B2StorageAdapter(
      {
        endpoint: 'https://s3.us-east-005.backblazeb2.com',
        region: 'us-east-005',
        bucket: 'test-bucket',
        keyId: 'test-key-id',
        applicationKey: 'test-application-key',
      },
      mockClient,
    );

    const result = await adapter.readBackupStream('stream.odbackup');
    const chunks: Uint8Array[] = [];
    for await (const chunk of result.stream) chunks.push(chunk);

    expect(
      Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString(),
    ).toBe('first-second');
    expect(result.metadata).toEqual({ 'dot-id': 'dot-alpha' });
    expect(result.versionId).toBe('v3');
  });

  it('handles empty streaming uploads via PutObjectCommand', async () => {
    const calls: Array<{ name: string; input: Record<string, unknown> }> = [];
    const mockClient = {
      send: vi.fn(async (command: unknown) => {
        const item = command as {
          constructor: { name: string };
          input: Record<string, unknown>;
        };
        calls.push({ name: item.constructor.name, input: item.input });
        return { ETag: '"empty-etag"', VersionId: 'v-empty' };
      }),
    } as unknown as S3Client;
    const adapter = new B2StorageAdapter(
      {
        endpoint: 'https://s3.us-east-005.backblazeb2.com',
        region: 'us-east-005',
        bucket: 'test-bucket',
        keyId: 'test-key-id',
        applicationKey: 'test-application-key',
      },
      mockClient,
    );

    const emptyStream = Readable.from([]);
    const result = await adapter.writeBackupStream(
      'empty.odbackup',
      emptyStream,
    );

    expect(result.eTag).toBe('"empty-etag"');
    expect(calls.map((c) => c.name)).toEqual(['PutObjectCommand']);
    expect(calls[0]!.input.Body).toEqual(Buffer.alloc(0));
  });

  it('aborts multipart upload when source stream throws an error', async () => {
    const commandNames: string[] = [];
    const mockClient = {
      send: vi.fn(async (command: unknown) => {
        const item = command as { constructor: { name: string } };
        commandNames.push(item.constructor.name);
        if (item.constructor.name === 'CreateMultipartUploadCommand') {
          return { UploadId: 'upload-src-fail' };
        }
        if (item.constructor.name === 'UploadPartCommand') {
          return { ETag: '"part-1-etag"' };
        }
        if (item.constructor.name === 'AbortMultipartUploadCommand') {
          return {};
        }
        throw new Error(`Unexpected S3 command: ${item.constructor.name}`);
      }),
    } as unknown as S3Client;
    const adapter = new B2StorageAdapter(
      {
        endpoint: 'https://s3.us-east-005.backblazeb2.com',
        region: 'us-east-005',
        bucket: 'test-bucket',
        keyId: 'test-key-id',
        applicationKey: 'test-application-key',
      },
      mockClient,
    );

    async function* failingSource() {
      yield Buffer.alloc(5 * 1024 * 1024, 0x55);
      throw new Error('source read failed midway');
    }

    await expect(
      adapter.writeBackupStream('failing-source.odbackup', failingSource()),
    ).rejects.toThrow('source read failed midway');

    expect(commandNames).toEqual([
      'CreateMultipartUploadCommand',
      'UploadPartCommand',
      'AbortMultipartUploadCommand',
    ]);
  });

  it('wraps error with abort details when AbortMultipartUploadCommand fails', async () => {
    const mockClient = {
      send: vi.fn(async (command: unknown) => {
        const item = command as { constructor: { name: string } };
        if (item.constructor.name === 'CreateMultipartUploadCommand') {
          return { UploadId: 'upload-abort-fail' };
        }
        if (item.constructor.name === 'UploadPartCommand') {
          throw new Error('upload part connection reset');
        }
        if (item.constructor.name === 'AbortMultipartUploadCommand') {
          throw new Error('abort call network error');
        }
        throw new Error(`Unexpected S3 command: ${item.constructor.name}`);
      }),
    } as unknown as S3Client;
    const adapter = new B2StorageAdapter(
      {
        endpoint: 'https://s3.us-east-005.backblazeb2.com',
        region: 'us-east-005',
        bucket: 'test-bucket',
        keyId: 'test-key-id',
        applicationKey: 'test-application-key',
      },
      mockClient,
    );

    async function* source() {
      yield Buffer.alloc(5 * 1024 * 1024, 0x66);
      yield Buffer.alloc(10, 0x77);
    }

    await expect(
      adapter.writeBackupStream('abort-failed.odbackup', source()),
    ).rejects.toThrow(
      /Multipart abort failed after B2 upload error: abort call network error/,
    );
  });

  it('cancels readBackupStream when signal is aborted', async () => {
    const controller = new AbortController();
    const mockClient = {
      send: vi.fn(async () => ({
        Body: (async function* () {
          yield Buffer.from('chunk-1');
          controller.abort(new Error('consumer cancelled download'));
          yield Buffer.from('chunk-2');
        })(),
      })),
    } as unknown as S3Client;
    const adapter = new B2StorageAdapter(
      {
        endpoint: 'https://s3.us-east-005.backblazeb2.com',
        region: 'us-east-005',
        bucket: 'test-bucket',
        keyId: 'test-key-id',
        applicationKey: 'test-application-key',
      },
      mockClient,
    );

    const result = await adapter.readBackupStream(
      'cancel.odbackup',
      controller.signal,
    );
    await expect(async () => {
      for await (const chunk of result.stream) {
        void chunk;
      }
    }).rejects.toThrow(/cancelled/i);
  });
});

class MemoryStorageAdapter implements StorageAdapter {
  storage = new Map<
    string,
    { data: Buffer; metadata?: Record<string, string> }
  >();

  async writeBackup(
    key: string,
    data: Buffer,
    metadata?: Record<string, string>,
  ) {
    this.storage.set(key, { data, metadata });
    return { key, eTag: '"mock-etag"' };
  }

  async writeBackupStream(
    key: string,
    source: AsyncIterable<Uint8Array>,
    metadata?: Record<string, string>,
  ) {
    const chunks: Buffer[] = [];
    for await (const chunk of source) chunks.push(Buffer.from(chunk));
    return this.writeBackup(key, Buffer.concat(chunks), metadata);
  }

  async readBackupStream(key: string) {
    const entry = this.storage.get(key);
    if (!entry) throw new Error('NoSuchKey: Object does not exist');
    const data = entry.data;
    async function* fragments() {
      const fragmentSize = 97;
      for (let offset = 0; offset < data.length; offset += fragmentSize) {
        yield data.subarray(offset, offset + fragmentSize);
      }
    }
    return {
      stream: fragments(),
      metadata: entry.metadata,
      versionId: 'memory-v1',
    };
  }

  async readBackup(key: string) {
    const entry = this.storage.get(key);
    if (!entry) throw new Error('NoSuchKey: Object does not exist');
    return { data: entry.data, metadata: entry.metadata };
  }

  async hasBackup(key: string) {
    return this.storage.has(key);
  }

  async getMetadata(key: string): Promise<BackupMetadata | null> {
    const entry = this.storage.get(key);
    if (!entry) return null;
    const meta = entry.metadata || {};
    return {
      key,
      dotId: meta['dot-id'] || '',
      backupId: meta['backup-id'] || '',
      backupType:
        (meta['backup-type'] as BackupMetadata['backupType']) || 'workspace',
      byteLength: entry.data.length,
      createdAt: Number(meta['created-at']) || 0,
      unencryptedSha256: meta['unencrypted-sha256'],
      encryptedSha256: meta['encrypted-sha256'],
    };
  }

  async deleteBackup(key: string) {
    this.storage.delete(key);
  }

  async listBackups(prefix?: string) {
    const results: Array<{ key: string; size: number; lastModified: Date }> =
      [];
    for (const [key, val] of this.storage.entries()) {
      if (!prefix || key.startsWith(prefix)) {
        results.push({
          key,
          size: val.data.length,
          lastModified: new Date(),
        });
      }
    }
    return results;
  }
}

const hexKey =
  'a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90';

describe('BackupService End-to-End Workflow & Tenant Isolation', () => {
  it('creates and restores a V2 stream only after manifest and archive validation', async () => {
    const memory = new MemoryStorageAdapter();
    const service = new BackupService(memory, Buffer.from(hexKey, 'hex'));
    // ODAR-Stream v2 currently frames gzip-compressed tar payloads.
    // A 1024-byte tar terminator is sufficient for this crypto/transaction test;
    // the incremental tar parser is qualified separately before production enablement.
    const archive = gzipSync(Buffer.alloc(1024));

    async function* source() {
      for (let offset = 0; offset < archive.length; offset += 43) {
        yield archive.subarray(offset, offset + 43);
      }
    }

    const receipt = await service.createStreamingBackup({
      dotId: 'dot-stream',
      backupType: 'workspace',
      source: source(),
    });
    expect(receipt.formatVersion).toBe(2);
    expect(memory.storage.get(receipt.key)?.metadata).toMatchObject({
      'backup-version': '2',
      'backup-format': 'odar-stream-v2',
      'dot-id': 'dot-stream',
      'backup-id': receipt.backupId,
    });

    const stagedChunks: Buffer[] = [];
    const events: string[] = [];
    const restored = await service.restoreStreamingBackup({
      dotId: 'dot-stream',
      backupId: receipt.backupId,
      backupType: 'workspace',
      createStage: async () => ({
        async write(chunk) {
          stagedChunks.push(Buffer.from(chunk));
          events.push('write');
        },
        async validate() {
          const unpacked = gunzipSync(Buffer.concat(stagedChunks));
          expect(unpacked).toEqual(Buffer.alloc(1024));
          events.push('validate');
        },
        async commit() {
          events.push('commit');
          return Buffer.concat(stagedChunks);
        },
        async rollback() {
          events.push('rollback');
        },
      }),
    });

    expect(restored).toEqual(archive);
    expect(events.at(-2)).toBe('validate');
    expect(events.at(-1)).toBe('commit');
    expect(events).not.toContain('rollback');
  });

  it('rolls back staged data when the V2 final-manifest tag is corrupt', async () => {
    const memory = new MemoryStorageAdapter();
    const service = new BackupService(memory, Buffer.from(hexKey, 'hex'));
    const archive = gzipSync(Buffer.alloc(1024));

    const receipt = await service.createStreamingBackup({
      dotId: 'dot-rollback',
      backupType: 'workspace',
      source: (async function* () {
        yield archive;
      })(),
    });
    const stored = memory.storage.get(receipt.key);
    if (!stored) throw new Error('Expected the V2 object to exist.');
    stored.data[stored.data.length - 1] ^= 0x01;

    const events: string[] = [];
    await expect(
      service.restoreStreamingBackup({
        dotId: 'dot-rollback',
        backupId: receipt.backupId,
        backupType: 'workspace',
        createStage: async () => ({
          async write() {
            events.push('write');
          },
          async validate() {
            events.push('validate');
          },
          async commit() {
            events.push('commit');
          },
          async rollback() {
            events.push('rollback');
          },
        }),
      }),
    ).rejects.toThrow(/final manifest authentication failed/);

    expect(events).toContain('write');
    expect(events).toContain('rollback');
    expect(events).not.toContain('validate');
    expect(events).not.toContain('commit');
  });

  it('creates, verifies, lists, and restores backups with strict tenant isolation', async () => {
    const memory = new MemoryStorageAdapter();
    const service = new BackupService(memory, Buffer.from(hexKey, 'hex'));

    const dot1 = 'dot-alpha';
    const dot2 = 'dot-beta';

    const secretData = Buffer.from(
      'Alpha confidential workspace archive',
      'utf8',
    );

    // 1. Create backup for dot1
    const envelope = await service.createBackup({
      dotId: dot1,
      backupType: 'workspace',
      plaintext: secretData,
    });

    expect(envelope.dotId).toBe(dot1);
    expect(envelope.formatVersion).toBe(1);

    // 2. Dot isolation: dot2 cannot see dot1's backups
    const dot1List = await service.listDotBackups(dot1);
    const dot2List = await service.listDotBackups(dot2);

    expect(dot1List).toHaveLength(1);
    expect(dot1List[0].backupId).toBe(envelope.backupId);
    expect(dot2List).toHaveLength(0); // Dot2 sees nothing

    // 3. Dot2 cannot restore Dot1's backup
    await expect(
      service.restoreBackup(dot2, envelope.backupId, 'workspace'),
    ).rejects.toThrow('NoSuchKey');

    // 4. Dot1 successfully restores and decrypts verified data
    const restored = await service.restoreBackup(
      dot1,
      envelope.backupId,
      'workspace',
    );
    expect(restored.envelope.backupId).toBe(envelope.backupId);
    expect(restored.plaintext.toString('utf8')).toBe(
      secretData.toString('utf8'),
    );

    // 5. Delete backup
    await service.deleteBackup(dot1, envelope.backupId, 'workspace');
    expect(await service.listDotBackups(dot1)).toHaveLength(0);
  });
});

describe('ComputerService Backup Lifecycle Integration', () => {
  it('integrates backup and restore lifecycle methods with audit recording', async () => {
    const workspace = new WorkspaceStore(':memory:', 'owner');
    const dot = workspace.dots()[0];
    const restoredArchive = createArchive('browser-profile', [
      { path: 'Default/Cookies', data: Buffer.from('restored-profile-data') },
    ]);
    const importData = vi.fn().mockResolvedValue(undefined);

    const mockBackupService = {
      createBackup: vi.fn().mockResolvedValue({
        formatVersion: 1,
        dotId: dot.id,
        backupId: 'backup-mock-id',
        createdAt: Date.now(),
        backupType: 'browser-profile',
      }),
      restoreBackup: vi.fn().mockResolvedValue({
        envelope: { backupId: 'backup-mock-id', backupType: 'browser-profile' },
        plaintext: restoredArchive,
      }),
      listDotBackups: vi
        .fn()
        .mockResolvedValue([
          { backupId: 'backup-mock-id', backupType: 'browser-profile' },
        ]),
    } as unknown as BackupService;

    const config = {
      baseUrl: 'http://localhost',
      voiceName: 'marin',
      slackUsers: [],
      runtimeUrl: 'http://localhost',
    };

    const mockProvider: ComputerProvider = {
      id: 'b2-test-provider',
      configured: true,
      async get(dotId) {
        return { dotId, status: 'running', endpoint: 'http://127.0.0.1:4100' };
      },
      async ensure(dotId) {
        return { dotId, status: 'running', endpoint: 'http://127.0.0.1:4100' };
      },
      async stop() {},
      importData,
    };

    const service = new ComputerService(
      workspace,
      { ...config, computerToken: 'test-only-computer-token-1234567890' },
      () => false,
      fetch,
      5000,
      mockProvider,
      mockBackupService as unknown as BackupService,
    );

    // Snapshot
    const backupRes = await service.snapshot(
      dot.id,
      'browser-profile',
      Buffer.from('profile-bytes'),
    );
    expect(backupRes.backupId).toBe('backup-mock-id');
    expect(mockBackupService.createBackup).toHaveBeenCalled();

    // Verify audit record was created
    const audit = workspace.computers.audit(dot.id);
    expect(audit.some((a) => a.action === 'backup_browser-profile')).toBe(true);

    // Restore
    const restoredRes = await service.restore(
      dot.id,
      'backup-mock-id',
      'browser-profile',
    );
    // The verified payload must really have been applied before success is reported,
    // and the decrypted bytes must not be handed back to the caller.
    expect(importData).toHaveBeenCalledTimes(1);
    expect(importData.mock.calls[0][1]).toBe('browser-profile');
    expect(importData.mock.calls[0][2]).toEqual(restoredArchive);
    expect(restoredRes.restored).toBe(true);
    expect('plaintext' in restoredRes).toBe(false);
    expect(
      workspace.computers
        .audit(dot.id)
        .some((a) => a.action === 'restore_browser-profile'),
    ).toBe(true);

    // List
    const list = await service.listBackups(dot.id);
    expect(list).toHaveLength(1);
    workspace.close();
  });

  it('rejects createStreamingBackup when storage adapter lacks streaming support', async () => {
    const service = new BackupService(
      {
        writeBackup: vi.fn(),
        readBackup: vi.fn(),
        hasBackup: vi.fn(),
        getMetadata: vi.fn(),
        deleteBackup: vi.fn(),
        listBackups: vi.fn(),
      },
      Buffer.from(hexKey, 'hex'),
    );
    await expect(
      service.createStreamingBackup({
        dotId: 'dot-1',
        backupType: 'workspace',
        source: (async function* () {})(),
      }),
    ).rejects.toThrow(/does not support streaming backups/);
  });

  it('rejects restoreStreamingBackup when storage adapter lacks streaming support', async () => {
    const service = new BackupService(
      {
        writeBackup: vi.fn(),
        readBackup: vi.fn(),
        hasBackup: vi.fn(),
        getMetadata: vi.fn(),
        deleteBackup: vi.fn(),
        listBackups: vi.fn(),
      },
      Buffer.from(hexKey, 'hex'),
    );
    await expect(
      service.restoreStreamingBackup({
        dotId: 'dot-1',
        backupId: 'backup-mock-id',
        backupType: 'workspace',
        createStage: vi.fn(),
      }),
    ).rejects.toThrow(/does not support streaming restores/);
  });

  it('rejects restoreStreamingBackup when metadata does not match requested identity', async () => {
    const memory = new MemoryStorageAdapter();
    const service = new BackupService(memory, Buffer.from(hexKey, 'hex'));
    const archive = gzipSync(Buffer.alloc(128));
    const receipt = await service.createStreamingBackup({
      dotId: 'dot-valid',
      backupType: 'workspace',
      source: (async function* () {
        yield archive;
      })(),
    });

    // Tamper with stored metadata
    const stored = memory.storage.get(receipt.key);
    if (!stored) throw new Error('Expected stored backup object');
    stored.metadata = {
      ...stored.metadata,
      'dot-id': 'tampered-dot-id',
    };

    await expect(
      service.restoreStreamingBackup({
        dotId: 'dot-valid',
        backupId: receipt.backupId,
        backupType: 'workspace',
        createStage: vi.fn(),
      }),
    ).rejects.toThrow(/metadata does not match/);
  });

  it('supports ComputerService streaming backup and transactional restore lifecycle', async () => {
    const workspace = new WorkspaceStore(':memory:', 'owner');
    const dot = workspace.dots()[0];
    const archive = createArchive('workspace', [
      { path: 'notes.txt', data: Buffer.from('streamed-notes') },
    ]);
    const importDataStream = vi.fn().mockResolvedValue(undefined);

    const mockBackupService = {
      createStreamingBackup: vi.fn().mockResolvedValue({
        formatVersion: 2,
        dotId: dot.id,
        backupId: 'backup-stream-mock-id',
        createdAt: Date.now(),
        backupType: 'workspace',
        key: 'backups/dot-1/workspace/backup-stream-mock-id.odbackup',
      }),
      restoreStreamingBackup: vi.fn(
        async (options: {
          createStage: () => Promise<{
            write: (chunk: Uint8Array) => Promise<void>;
            validate: () => Promise<void>;
            commit: () => Promise<unknown>;
          }>;
        }) => {
          const stage = await options.createStage();
          await stage.write(archive);
          await stage.validate();
          return await stage.commit();
        },
      ),
    } as unknown as BackupService;

    const config = {
      baseUrl: 'http://localhost',
      voiceName: 'marin',
      slackUsers: [],
      runtimeUrl: 'http://localhost',
    };

    const mockProvider: ComputerProvider = {
      id: 'streaming-provider',
      configured: true,
      async get(dotId) {
        return { dotId, status: 'running', endpoint: 'http://127.0.0.1:4100' };
      },
      async ensure(dotId) {
        return { dotId, status: 'running', endpoint: 'http://127.0.0.1:4100' };
      },
      async stop() {},
      exportDataStream: vi.fn(async () => {
        async function* gen() {
          yield archive;
        }
        return gen();
      }),
      importDataStream,
    };

    const service = new ComputerService(
      workspace,
      { ...config, computerToken: 'test-only-computer-token-1234567890' },
      () => false,
      fetch,
      5000,
      mockProvider,
      mockBackupService,
    );

    // 1. Snapshot Streaming
    const receipt = await service.snapshotStreaming(dot.id, 'workspace');
    expect(receipt.backupId).toBe('backup-stream-mock-id');
    expect(mockProvider.exportDataStream).toHaveBeenCalledTimes(1);
    expect(mockBackupService.createStreamingBackup).toHaveBeenCalledTimes(1);
    expect(
      workspace.computers
        .audit(dot.id)
        .some((a) => a.action === 'backup_workspace'),
    ).toBe(true);

    // 2. Restore Streaming
    const restoreRes = await service.restoreStreaming(
      dot.id,
      'backup-stream-mock-id',
      'workspace',
    );
    expect(restoreRes.restored).toBe(true);
    expect(importDataStream).toHaveBeenCalledTimes(1);
    expect(
      workspace.computers
        .audit(dot.id)
        .some((a) => a.action === 'restore_workspace'),
    ).toBe(true);

    workspace.close();
  });
});
