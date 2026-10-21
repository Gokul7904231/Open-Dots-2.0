import { isAbsolute, resolve } from 'node:path';

export interface ArchiveSafetyLimits {
  maxTotalBytes?: number; // Default 500MB
  maxFiles?: number; // Default 10,000 files
  maxSingleFileBytes?: number; // Default 100MB
}

export const DEFAULT_SAFETY_LIMITS: Required<ArchiveSafetyLimits> = {
  maxTotalBytes: 500 * 1024 * 1024, // 500 MB
  maxFiles: 10_000,
  maxSingleFileBytes: 100 * 1024 * 1024, // 100 MB
};

/**
 * Validates that an archive relative path does not escape the destination directory.
 * Prevents directory traversal attacks (e.g. ../../etc/passwd or absolute paths).
 */
export function assertSafeArchivePath(
  entryPath: string,
  destinationDir: string,
): string {
  if (!entryPath || typeof entryPath !== 'string') {
    throw new Error(
      'Invalid archive entry path: path must be a non-empty string.',
    );
  }

  // Reject null bytes immediately
  if (entryPath.includes('\0')) {
    throw new Error(
      `Null byte detected in archive path: ${JSON.stringify(entryPath)}`,
    );
  }

  // Reject Windows drive letters and UNC paths
  if (/^[A-Za-z]:/.test(entryPath) || entryPath.startsWith('\\\\')) {
    throw new Error(
      `Absolute drive or UNC path not permitted in archive: ${entryPath}`,
    );
  }

  // Reject absolute paths
  if (
    isAbsolute(entryPath) ||
    entryPath.startsWith('/') ||
    entryPath.startsWith('\\')
  ) {
    throw new Error(`Absolute archive path traversal attempt: ${entryPath}`);
  }

  const resolvedBase = resolve(destinationDir);
  const resolvedTarget = resolve(destinationDir, entryPath);

  // Must remain strictly within destinationDir (prevent ../ escapes)
  const isInside =
    resolvedTarget === resolvedBase ||
    resolvedTarget.startsWith(resolvedBase + '\\') ||
    resolvedTarget.startsWith(resolvedBase + '/');

  if (!isInside) {
    throw new Error(
      `Path traversal escape detected: ${entryPath} -> ${resolvedTarget}`,
    );
  }

  return resolvedTarget;
}

/**
 * Validates extraction budget against potential zip bombs or oversized archives.
 */
export class ArchiveBudgetTracker {
  private totalBytes = 0;
  private totalFiles = 0;
  private readonly limits: Required<ArchiveSafetyLimits>;

  constructor(limits?: ArchiveSafetyLimits) {
    this.limits = { ...DEFAULT_SAFETY_LIMITS, ...limits };
  }

  trackFile(byteSize: number, filename: string): void {
    this.totalFiles += 1;
    if (this.totalFiles > this.limits.maxFiles) {
      throw new Error(
        `Archive file count limit exceeded (${this.limits.maxFiles} files max). Possible zip-bomb.`,
      );
    }

    if (byteSize > this.limits.maxSingleFileBytes) {
      throw new Error(
        `File ${filename} exceeds single file size limit (${this.limits.maxSingleFileBytes} bytes).`,
      );
    }

    this.totalBytes += byteSize;
    if (this.totalBytes > this.limits.maxTotalBytes) {
      throw new Error(
        `Archive total uncompressed size limit exceeded (${this.limits.maxTotalBytes} bytes max). Possible decompression bomb.`,
      );
    }
  }

  stats() {
    return {
      totalFiles: this.totalFiles,
      totalBytes: this.totalBytes,
    };
  }
}
