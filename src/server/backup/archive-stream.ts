import { createReadStream } from 'node:fs';
import { statfs } from 'node:fs/promises';
import { createGunzip } from 'node:zlib';
import { Readable } from 'node:stream';
import {
  ArchiveBudgetTracker,
  assertSafeArchivePath,
  DEFAULT_SAFETY_LIMITS,
} from './archive-safety.js';
import type { BackupType } from './types.js';

export interface ValidateArchiveOptions {
  strict?: boolean;
  expectedType?: BackupType;
  maxTotalBytes?: number;
  maxFiles?: number;
  maxSingleFileBytes?: number;
}

const RESERVED_PREFIXES = ['.opendots-b2-', '.opendots-restore-'];

function isReservedPath(path: string): boolean {
  return path
    .split('/')
    .some((part) =>
      RESERVED_PREFIXES.some((prefix) => part.startsWith(prefix)),
    );
}

function textAt(buffer: Uint8Array, offset: number, length: number): string {
  const field = buffer.subarray(offset, offset + length);
  const zero = field.indexOf(0);
  const slice = zero < 0 ? field : field.subarray(0, zero);
  return new TextDecoder('utf8').decode(slice);
}

function octalAt(buffer: Uint8Array, offset: number, length: number): number {
  const value = textAt(buffer, offset, length).trim();
  if (!value) return 0;
  if (!/^[0-7]+$/.test(value)) {
    throw new Error('Unsupported non-octal tar metadata.');
  }
  const parsed = Number.parseInt(value, 8);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error('Invalid tar metadata value.');
  }
  return parsed;
}

function parsePax(buffer: Uint8Array): Record<string, string> {
  const result: Record<string, string> = {};
  let offset = 0;
  const decoder = new TextDecoder('utf8');
  while (offset < buffer.length) {
    const space = buffer.indexOf(0x20, offset);
    if (space < 0) throw new Error('Malformed tar PAX record.');
    const lengthText = textAt(buffer, offset, space - offset);
    if (!/^\d+$/.test(lengthText)) {
      throw new Error('Malformed tar PAX record length.');
    }
    const length = Number.parseInt(lengthText, 10);
    if (
      !Number.isSafeInteger(length) ||
      length <= space - offset + 2 ||
      offset + length > buffer.length
    ) {
      throw new Error('Malformed tar PAX record bounds.');
    }
    const record = decoder
      .decode(buffer.subarray(space + 1, offset + length))
      .replace(/\n$/, '');
    const equals = record.indexOf('=');
    if (equals <= 0) throw new Error('Malformed tar PAX record value.');
    result[record.slice(0, equals)] = record.slice(equals + 1);
    offset += length;
  }
  return result;
}

/**
 * Validates an uncompressed tar stream incrementally block by block.
 * Uses bounded memory (O(1) block buffer) regardless of archive size.
 */
export async function validateTarStream(
  tarStream: AsyncIterable<Uint8Array>,
  options: ValidateArchiveOptions = {},
): Promise<{ fileCount: number; totalBytes: number; format: 'tar' }> {
  const tracker = new ArchiveBudgetTracker({
    maxTotalBytes: options.maxTotalBytes,
    maxFiles: options.maxFiles,
    maxSingleFileBytes: options.maxSingleFileBytes,
  });

  let blockBuffer = Buffer.alloc(0);
  let localPax: Record<string, string> = {};
  let globalPax: Record<string, string> = {};
  let longName: string | undefined;

  let fileRemaining = 0;
  let filePaddingRemaining = 0;
  let sawHeader = false;

  const reader = async function* () {
    for await (const chunk of tarStream) {
      yield Buffer.from(chunk);
    }
  };

  const streamIter = reader();

  async function fillBuffer(requiredBytes: number): Promise<boolean> {
    while (blockBuffer.length < requiredBytes) {
      const next = await streamIter.next();
      if (next.done) return false;
      blockBuffer = Buffer.concat([blockBuffer, next.value]);
    }
    return true;
  }

  for (;;) {
    // If skipping file content
    if (fileRemaining > 0 || filePaddingRemaining > 0) {
      const needed = fileRemaining + filePaddingRemaining;
      const available = Math.min(blockBuffer.length, needed);
      if (available > 0) {
        if (fileRemaining > 0) {
          const contentBytes = Math.min(fileRemaining, available);
          fileRemaining -= contentBytes;
        }
        const remainingToSkip = available - Math.min(fileRemaining, available);
        if (remainingToSkip > 0 && filePaddingRemaining > 0) {
          filePaddingRemaining -= Math.min(
            filePaddingRemaining,
            remainingToSkip,
          );
        }
        blockBuffer = blockBuffer.subarray(available);
      }
      if (fileRemaining > 0 || filePaddingRemaining > 0) {
        const hasMore = await fillBuffer(512);
        if (!hasMore) {
          throw new Error('Tar archive is truncated in file data.');
        }
      }
      continue;
    }

    const hasBlock = await fillBuffer(512);
    if (!hasBlock) {
      if (!sawHeader) {
        throw new Error('Tar archive is empty.');
      }
      break;
    }

    const header = blockBuffer.subarray(0, 512);
    blockBuffer = blockBuffer.subarray(512);

    // Check for EOF block (512 zeroes)
    if (header.every((b) => b === 0)) {
      // Reached zero block, rest should be zero or EOF
      break;
    }

    sawHeader = true;

    // Checksum check
    const storedChecksum = octalAt(header, 148, 8);
    const checksumHeader = Buffer.from(header);
    checksumHeader.fill(0x20, 148, 156);
    const actualChecksum = checksumHeader.reduce((sum, byte) => sum + byte, 0);
    if (storedChecksum !== actualChecksum) {
      throw new Error('Tar header checksum is invalid.');
    }

    const name = textAt(header, 0, 100);
    const prefix = textAt(header, 345, 155);
    const headerPath = prefix ? `${prefix}/${name}` : name;
    const headerSize = octalAt(header, 124, 12);
    const typeflag = header[156] === 0 ? '0' : String.fromCharCode(header[156]);

    // Handle PAX header
    if (typeflag === 'x' || typeflag === 'g') {
      const hasContent = await fillBuffer(headerSize);
      if (!hasContent) {
        throw new Error('Truncated PAX header in tar archive.');
      }
      const paxPayload = blockBuffer.subarray(0, headerSize);
      const padding = (512 - (headerSize % 512)) % 512;
      blockBuffer = blockBuffer.subarray(headerSize);
      if (padding > 0) {
        await fillBuffer(padding);
        blockBuffer = blockBuffer.subarray(padding);
      }
      const parsedPax = parsePax(paxPayload);
      if (typeflag === 'g') globalPax = { ...globalPax, ...parsedPax };
      else localPax = { ...localPax, ...parsedPax };
      continue;
    }

    // Handle GNU LongLink
    if (typeflag === 'L') {
      const hasContent = await fillBuffer(headerSize);
      if (!hasContent) {
        throw new Error('Truncated long name in tar archive.');
      }
      const payload = blockBuffer.subarray(0, headerSize);
      const padding = (512 - (headerSize % 512)) % 512;
      blockBuffer = blockBuffer.subarray(headerSize);
      if (padding > 0) {
        await fillBuffer(padding);
        blockBuffer = blockBuffer.subarray(padding);
      }
      longName = new TextDecoder('utf8')
        .decode(payload)
        .replace(/\0.*$/s, '')
        .replace(/\n$/, '');
      continue;
    }

    if (typeflag === 'K') {
      throw new Error('Tar hard-link metadata is not allowed.');
    }

    const rawEntryPath =
      localPax.path || globalPax.path || longName || headerPath;
    localPax = {};
    longName = undefined;

    const normalizedPath = rawEntryPath
      .replace(/^\.\/+/, '')
      .replace(/\/+$/, '');
    if (!normalizedPath) {
      // Directory root or empty
      fileRemaining = headerSize;
      filePaddingRemaining = (512 - (headerSize % 512)) % 512;
      continue;
    }

    // Skip reserved restore marker directories
    if (isReservedPath(normalizedPath)) {
      fileRemaining = headerSize;
      filePaddingRemaining = (512 - (headerSize % 512)) % 512;
      continue;
    }

    // Validate path safety against directory traversal
    assertSafeArchivePath(normalizedPath, 'safe_root');

    // Reject links and special files
    if (typeflag === '2' || typeflag === '1') {
      const baseName = normalizedPath.split('/').at(-1);
      const singleton =
        options.expectedType === 'browser-profile' &&
        ['SingletonLock', 'SingletonSocket', 'SingletonCookie'].includes(
          baseName ?? '',
        );
      if (!singleton) {
        throw new Error(
          'Symbolic and hard links are not permitted in computer backups.',
        );
      }
      fileRemaining = headerSize;
      filePaddingRemaining = (512 - (headerSize % 512)) % 512;
      continue;
    }

    if (typeflag === '5') {
      // Directory entry
      fileRemaining = headerSize;
      filePaddingRemaining = (512 - (headerSize % 512)) % 512;
      continue;
    }

    if (typeflag !== '0' && typeflag !== '7') {
      throw new Error(
        `Unsupported special file (type '${typeflag}') in computer backup.`,
      );
    }

    // Enforce type sections for full-computer
    if (options.expectedType === 'full-computer') {
      if (
        !normalizedPath.startsWith('workspace/') &&
        !normalizedPath.startsWith('browser-profile/')
      ) {
        throw new Error(
          'Full-computer archive contains an unknown data section.',
        );
      }
    }

    // Track budgets
    tracker.trackFile(headerSize, normalizedPath);

    fileRemaining = headerSize;
    filePaddingRemaining = (512 - (headerSize % 512)) % 512;
  }

  const { totalFiles, totalBytes } = tracker.stats();
  return {
    fileCount: totalFiles,
    totalBytes,
    format: 'tar',
  };
}

/**
 * Validates a gzipped archive stream (either gzip-tar-v1 or legacy gzipped ODAR JSON).
 * Streams decompression and validation with bounded memory.
 */
export async function validateArchiveStream(
  byteStream: AsyncIterable<Uint8Array>,
  options: ValidateArchiveOptions = {},
): Promise<{
  fileCount: number;
  totalBytes: number;
  format: 'tar' | 'odar-v1';
}> {
  // Read first 2 bytes to check gzip magic
  const iterator = byteStream[Symbol.asyncIterator]();
  const first = await iterator.next();
  if (first.done || !first.value || first.value.length < 2) {
    throw new Error('Invalid archive: stream is empty or too short.');
  }

  const firstChunk = Buffer.from(first.value);
  const isGzip = firstChunk[0] === 0x1f && firstChunk[1] === 0x8b;

  async function* fullRawStream() {
    yield firstChunk;

    for (;;) {
      const next = await iterator.next();
      if (next.done) break;
      yield next.value;
    }
  }

  if (isGzip) {
    const gunzip = createGunzip();
    const source = Readable.from(fullRawStream());
    source.pipe(gunzip);

    // Test first decompressed bytes to distinguish tar vs ODAR JSON
    const gunzipIter = gunzip[Symbol.asyncIterator]();
    const firstGunzip = await gunzipIter.next();
    if (firstGunzip.done || !firstGunzip.value) {
      throw new Error('Decompressed archive stream is empty.');
    }
    const initialDecompressed = Buffer.from(firstGunzip.value);

    async function* gunzipStream() {
      yield initialDecompressed;
      for (;;) {
        const next = await gunzipIter.next();
        if (next.done) break;
        yield next.value;
      }
    }

    // Check if it's ODAR JSON (starts with '{')
    const trimmed = initialDecompressed
      .toString('utf8', 0, Math.min(100, initialDecompressed.length))
      .trimStart();
    if (trimmed.startsWith('{')) {
      // Legacy V1 ODAR JSON
      const collected: Buffer[] = [initialDecompressed];
      let total = initialDecompressed.length;
      for await (const chunk of gunzip) {
        total += chunk.length;
        if (total > DEFAULT_SAFETY_LIMITS.maxTotalBytes) {
          throw new Error('Archive total uncompressed size limit exceeded.');
        }
        collected.push(Buffer.from(chunk));
      }
      const jsonBuf = Buffer.concat(collected);
      let parsed: {
        magic?: string;
        version?: number;
        type?: string;
        files?: unknown[];
      };
      try {
        parsed = JSON.parse(jsonBuf.toString('utf8'));
      } catch {
        throw new Error('Backup payload is not a valid ODAR archive.');
      }
      if (parsed.magic !== 'ODAR' || parsed.version !== 1) {
        throw new Error('Unsupported or corrupt archive format.');
      }
      if (options.expectedType && parsed.type !== options.expectedType) {
        throw new Error(
          `Backup archive type "${parsed.type}" does not match requested type "${options.expectedType}".`,
        );
      }
      return {
        fileCount: Array.isArray(parsed.files) ? parsed.files.length : 0,
        totalBytes: total,
        format: 'odar-v1',
      };
    }

    // Otherwise, validate as streaming tar!
    const result = await validateTarStream(gunzipStream(), options);
    return { ...result, format: 'tar' };
  }

  // Not gzip: check uncompressed tar
  const result = await validateTarStream(fullRawStream(), options);
  return { ...result, format: 'tar' };
}

/**
 * Validates a staged archive file on disk using streaming validation.
 * Verifies path safety, budgets, checksums, and structure without loading file into memory.
 */
export async function validateArchiveFile(
  filePath: string,
  options: ValidateArchiveOptions = {},
): Promise<{
  fileCount: number;
  totalBytes: number;
  format: 'tar' | 'odar-v1';
}> {
  const fileStream = createReadStream(filePath);
  return validateArchiveStream(fileStream, options);
}

/**
 * Preflights available disk space for staging.
 * Fails before changing any live files if disk space is insufficient.
 */
export async function preflightStagingSpace(
  dirPath: string,
  requiredBytes: number,
): Promise<void> {
  try {
    const stats = await statfs(dirPath);
    if (
      stats &&
      typeof stats.bavail === 'bigint' &&
      typeof stats.bsize === 'bigint'
    ) {
      const available = stats.bavail * stats.bsize;
      if (available < BigInt(requiredBytes)) {
        throw new Error(
          `Insufficient disk space for staging: available ${available} bytes, required ${requiredBytes} bytes.`,
        );
      }
    }
  } catch (err) {
    if (
      err instanceof Error &&
      err.message.includes('Insufficient disk space')
    ) {
      throw err;
    }
    // statfs may not be supported on all filesystems or Windows mount types; proceed if check is unsupported
  }
}
