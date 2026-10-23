import { gzipSync, gunzipSync } from 'node:zlib';
import {
  assertSafeArchivePath,
  ArchiveBudgetTracker,
} from './archive-safety.js';
import type { BackupType } from './types.js';

export interface ArchiveEntry {
  path: string;
  data: Buffer;
  mtime?: number;
}

export interface StructuredArchive {
  magic: 'ODAR'; // OpenDots Archive
  version: 1;
  type: BackupType;
  createdAt: number;
  files: Array<{
    path: string;
    dataBase64: string;
    size: number;
    mtime?: number;
    mode?: number;
  }>;
}

export interface ExtractArchiveOptions {
  /**
   * Reject anything that is not an ODAR document. Use before applying a payload to a
   * computer: the lenient default accepts opaque payloads (such as raw smoke-test
   * bytes) as a single `payload.bin`, which would bypass every path check.
   */
  strict?: boolean;
  /** Require the archive to declare this backup type. */
  expectedType?: BackupType;
}

/**
 * Creates a compressed archive Buffer from a list of files.
 */
export function createArchive(
  type: BackupType,
  entries: ArchiveEntry[],
): Buffer {
  const structured: StructuredArchive = {
    magic: 'ODAR',
    version: 1,
    type,
    createdAt: Date.now(),
    files: entries.map((entry) => ({
      path: entry.path,
      dataBase64: entry.data.toString('base64'),
      size: entry.data.length,
      mtime: entry.mtime ?? Date.now(),
    })),
  };

  const jsonBytes = Buffer.from(JSON.stringify(structured), 'utf8');
  return gzipSync(jsonBytes);
}

/**
 * Extracts and validates an archive Buffer with path safety and budget tracking.
 */
export function extractArchive(
  archiveBuffer: Buffer,
  destinationDir?: string,
  options: ExtractArchiveOptions = {},
): ArchiveEntry[] {
  if (archiveBuffer.length < 2) {
    throw new Error('Invalid archive: buffer is empty or too short.');
  }

  let decompressed: Buffer;
  // Handle gzipped archive or raw archive
  if (archiveBuffer[0] === 0x1f && archiveBuffer[1] === 0x8b) {
    try {
      decompressed = gunzipSync(archiveBuffer);
    } catch (err) {
      throw new Error('Failed to decompress archive.', { cause: err });
    }
  } else {
    decompressed = archiveBuffer;
  }

  // Parse structured archive
  let structured: StructuredArchive;
  try {
    structured = JSON.parse(decompressed.toString('utf8'));
  } catch {
    if (options.strict) {
      throw new Error('Backup payload is not a valid ODAR archive.');
    }
    // If not JSON structured, check if it's a raw tar archive or single-file payload
    return [
      {
        path: 'payload.bin',
        data: decompressed,
      },
    ];
  }

  if (structured.magic !== 'ODAR' || structured.version !== 1) {
    throw new Error('Unsupported or corrupt archive format.');
  }
  if (options.expectedType && structured.type !== options.expectedType) {
    throw new Error(
      `Backup archive type "${structured.type}" does not match the requested type "${options.expectedType}".`,
    );
  }
  if (!Array.isArray(structured.files)) {
    throw new Error('Unsupported or corrupt archive format.');
  }

  const tracker = new ArchiveBudgetTracker();
  const results: ArchiveEntry[] = [];

  for (const file of structured.files) {
    // Validate relative path safety
    if (destinationDir) {
      assertSafeArchivePath(file.path, destinationDir);
    } else {
      // Basic check
      assertSafeArchivePath(file.path, 'safe_root');
    }

    const data = Buffer.from(file.dataBase64, 'base64');
    tracker.trackFile(data.length, file.path);

    results.push({
      path: file.path,
      data,
      mtime: file.mtime,
    });
  }

  return results;
}
