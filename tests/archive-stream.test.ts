import { describe, expect, it } from 'vitest';
import { gzipSync } from 'node:zlib';
import {
  validateArchiveStream,
  validateTarStream,
} from '../src/server/backup/archive-stream.js';
// @ts-expect-error - .mjs module has no TypeScript declarations
import { createTarArchive } from '../deployment/computers/b2-archive-format.mjs';

describe('Archive Stream Validation', () => {
  it('validates a valid gzip-tar-v1 stream incrementally', async () => {
    const tar = createTarArchive([
      { path: 'hello.txt', data: Buffer.from('hello world') },
      { path: 'sub/nested.txt', data: Buffer.from('nested content') },
    ]);
    const compressed = gzipSync(tar);

    async function* source() {
      // Yield in small fragments to test stream reassembly
      for (let i = 0; i < compressed.length; i += 23) {
        yield compressed.subarray(i, i + 23);
      }
    }

    const result = await validateArchiveStream(source(), {
      expectedType: 'workspace',
    });
    expect(result.format).toBe('tar');
    expect(result.fileCount).toBe(2);
    expect(result.totalBytes).toBe(
      Buffer.byteLength('hello world') + Buffer.byteLength('nested content'),
    );
  });

  it('rejects path traversal in tar stream', async () => {
    // Manually construct tar header with traversal path
    const header = Buffer.alloc(512, 0);
    header.write('../evil.txt', 0, 100);
    header.write('0000644', 100, 8, 'ascii');
    header.write('00000000005', 124, 12, 'ascii'); // 5 bytes
    header.write('00000000000', 136, 12, 'ascii');
    header.fill(0x20, 148, 156);
    header[156] = '0'.charCodeAt(0);
    const checksum = header.reduce((sum, b) => sum + b, 0);
    header.write(checksum.toString(8).padStart(6, '0'), 148, 6, 'ascii');
    header[154] = 0;
    header[155] = 0x20;

    const content = Buffer.alloc(512, 0);
    content.write('traversal');
    const trailer = Buffer.alloc(1024, 0);

    const badTar = Buffer.concat([header, content, trailer]);

    await expect(
      validateTarStream(
        (async function* () {
          yield badTar;
        })(),
      ),
    ).rejects.toThrow(/Path traversal escape/);
  });

  it('rejects symbolic links in tar stream', async () => {
    const header = Buffer.alloc(512, 0);
    header.write('symlink', 0, 100);
    header.write('0000777', 100, 8, 'ascii');
    header.write('00000000000', 124, 12, 'ascii');
    header.write('00000000000', 136, 12, 'ascii');
    header.fill(0x20, 148, 156);
    header[156] = '2'.charCodeAt(0); // symlink typeflag
    const checksum = header.reduce((sum, b) => sum + b, 0);
    header.write(checksum.toString(8).padStart(6, '0'), 148, 6, 'ascii');
    header[154] = 0;
    header[155] = 0x20;

    const badTar = Buffer.concat([header, Buffer.alloc(1024, 0)]);

    await expect(
      validateTarStream(
        (async function* () {
          yield badTar;
        })(),
      ),
    ).rejects.toThrow(/Symbolic and hard links are not permitted/);
  });

  it('rejects archives exceeding budget limits', async () => {
    const tar = createTarArchive([
      { path: 'big.bin', data: Buffer.alloc(2000) },
    ]);
    await expect(
      validateTarStream(
        (async function* () {
          yield tar;
        })(),
        { maxSingleFileBytes: 1000 },
      ),
    ).rejects.toThrow(/exceeds single file size limit/);
  });

  it('maintains backwards compatibility with legacy gzipped ODAR v1 JSON archives', async () => {
    const legacyDoc = {
      magic: 'ODAR',
      version: 1,
      type: 'workspace',
      createdAt: Date.now(),
      files: [
        {
          path: 'old.txt',
          dataBase64: Buffer.from('legacy content').toString('base64'),
          size: 14,
          mtime: Math.floor(Date.now() / 1000),
        },
      ],
    };
    const legacyGzip = gzipSync(Buffer.from(JSON.stringify(legacyDoc)));

    const result = await validateArchiveStream(
      (async function* () {
        yield legacyGzip;
      })(),
      { expectedType: 'workspace' },
    );
    expect(result.format).toBe('odar-v1');
    expect(result.fileCount).toBe(1);
  });
});
