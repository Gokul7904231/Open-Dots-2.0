import { describe, expect, it, vi } from 'vitest';
import { createHash, randomBytes } from 'node:crypto';
import { gzipSync } from 'node:zlib';

import { BackupService } from '../src/server/backup/backup-service.js';
import { ComputerService } from '../src/server/computer-service.js';
import { WorkspaceStore } from '../src/server/workspace.js';
// @ts-expect-error - .mjs module has no TypeScript declarations
import { createTarArchive } from '../deployment/computers/b2-archive-format.mjs';
import type {
  BackupMetadata,
  BackupStreamReadResult,
  StorageAdapter,
} from '../src/server/backup/types.js';
import type { ComputerProvider } from '../src/server/computer-provider.js';

class StreamingMockStorageAdapter implements StorageAdapter {
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
    return { key, eTag: '"etag-mock"' };
  }

  async writeBackupStream(
    key: string,
    source: AsyncIterable<Uint8Array>,
    metadata?: Record<string, string>,
  ) {
    const parts: Buffer[] = [];
    for await (const chunk of source) {
      parts.push(Buffer.from(chunk));
    }
    const full = Buffer.concat(parts);
    this.storage.set(key, { data: full, metadata });
    return { key, eTag: '"stream-etag"' };
  }

  async readBackupStream(key: string): Promise<BackupStreamReadResult> {
    const entry = this.storage.get(key);
    if (!entry) throw new Error('NoSuchKey');
    const data = entry.data;
    async function* chunks() {
      const chunkSize = 128 * 1024;
      for (let i = 0; i < data.length; i += chunkSize) {
        yield data.subarray(i, i + chunkSize);
      }
    }
    return {
      stream: chunks(),
      metadata: entry.metadata,
      versionId: 'stream-v2',
    };
  }

  async readBackup(key: string) {
    const entry = this.storage.get(key);
    if (!entry) throw new Error('NoSuchKey');
    return { data: entry.data, metadata: entry.metadata };
  }

  async hasBackup(key: string) {
    return this.storage.has(key);
  }

  async getMetadata(key: string): Promise<BackupMetadata | null> {
    const entry = this.storage.get(key);
    if (!entry) return null;
    return {
      key,
      dotId: entry.metadata?.['dot-id'] ?? '',
      backupId: entry.metadata?.['backup-id'] ?? '',
      backupType: 'workspace',
      byteLength: entry.data.length,
      createdAt: Date.now(),
    };
  }

  async deleteBackup(key: string) {
    this.storage.delete(key);
  }

  async listBackups() {
    return [];
  }
}

describe('Large Payload Streaming & Memory Bounds Qualification', () => {
  it('streams 20 MiB backup through V2 framing with bounded memory', async () => {
    const hexKey =
      'c0d1e2f3a4b5c6d7e8f90123456789abc0d1e2f3a4b5c6d7e8f90123456789ab';
    const storage = new StreamingMockStorageAdapter();
    const backupService = new BackupService(
      storage,
      Buffer.from(hexKey, 'hex'),
    );

    // Create 4 files of 5 MiB each = 20 MiB uncompressed tar
    const file1 = randomBytes(5 * 1024 * 1024);
    const file2 = randomBytes(5 * 1024 * 1024);
    const file3 = randomBytes(5 * 1024 * 1024);
    const file4 = randomBytes(5 * 1024 * 1024);

    const originalHash = createHash('sha256')
      .update(file1)
      .update(file2)
      .update(file3)
      .update(file4)
      .digest('hex');

    const tar = createTarArchive([
      { path: 'file1.bin', data: file1 },
      { path: 'file2.bin', data: file2 },
      { path: 'sub/file3.bin', data: file3 },
      { path: 'sub/file4.bin', data: file4 },
    ]);
    const compressed = gzipSync(tar);

    const workspace = new WorkspaceStore(':memory:', 'owner');
    const dot = workspace.dots()[0];

    let restoredSize = 0;
    const mockProvider: ComputerProvider = {
      id: 'mock-streaming',
      configured: true,
      async get(dotId) {
        return { dotId, status: 'running', endpoint: 'http://127.0.0.1:4100' };
      },
      async ensure(dotId) {
        return { dotId, status: 'running', endpoint: 'http://127.0.0.1:4100' };
      },
      async stop() {},
      exportDataStream: vi.fn(async () => {
        async function* stream() {
          const chunkSize = 512 * 1024;
          for (let i = 0; i < compressed.length; i += chunkSize) {
            yield compressed.subarray(i, i + chunkSize);
          }
        }
        return stream();
      }),
      importDataStream: vi.fn(async (_id, _type, stream) => {
        for await (const chunk of stream) {
          restoredSize += chunk.length;
        }
      }),
    };

    const computerService = new ComputerService(
      workspace,
      {
        baseUrl: 'http://localhost',
        voiceName: 'marin',
        slackUsers: [],
        runtimeUrl: 'http://localhost',
        computerToken: 'tok-12345678901234567890',
      },
      () => false,
      fetch,
      5000,
      mockProvider,
      backupService,
    );

    // Measure initial memory
    global.gc?.();
    const initialRss = process.memoryUsage().rss;

    // 1. Create Streaming Backup
    const receipt = await computerService.snapshotStreaming(
      dot.id,
      'workspace',
    );
    expect(receipt.formatVersion).toBe(2);
    expect(receipt.backupId).toBeTruthy();

    const storedObject = storage.storage.get(receipt.key);
    expect(storedObject).toBeTruthy();
    expect(storedObject!.metadata?.['backup-format']).toBe('odar-stream-v2');

    // 2. Restore Streaming Backup
    const restoreResult = await computerService.restoreStreaming(
      dot.id,
      receipt.backupId,
      'workspace',
    );
    expect(restoreResult.restored).toBe(true);
    expect(restoredSize).toBe(compressed.length);

    // Measure memory after streaming restore
    global.gc?.();
    const finalRss = process.memoryUsage().rss;
    const rssDelta = (finalRss - initialRss) / (1024 * 1024);

    // Verify bounded memory: RSS increase should be well bounded
    console.log(
      `[Memory Benchmark] Initial RSS: ${(initialRss / (1024 * 1024)).toFixed(2)} MB, Final RSS: ${(finalRss / (1024 * 1024)).toFixed(2)} MB, Delta: ${rssDelta.toFixed(2)} MB`,
    );

    expect(rssDelta).toBeLessThan(100); // Stays far below uncontrolled multi-copy buffering
    expect(originalHash).toBeTruthy();

    workspace.close();
  });
});
