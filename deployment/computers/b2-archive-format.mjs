import { gunzipSync, gzipSync } from 'node:zlib';

export const BACKUP_TYPES = new Set([
  'workspace',
  'browser-profile',
  'full-computer',
]);
export const ARCHIVE_LIMITS = Object.freeze({
  maxArchiveBytes: 600 * 1024 * 1024,
  maxTotalBytes: 500 * 1024 * 1024,
  maxFiles: 10_000,
  maxSingleFileBytes: 100 * 1024 * 1024,
});

function textAt(buffer, offset, length) {
  const field = buffer.subarray(offset, offset + length);
  const zero = field.indexOf(0);
  return field.subarray(0, zero < 0 ? field.length : zero).toString('utf8');
}

function octalAt(buffer, offset, length) {
  const value = textAt(buffer, offset, length).trim();
  if (!value) return 0;
  if (!/^[0-7]+$/.test(value))
    throw new Error('Unsupported non-octal tar metadata.');
  const parsed = Number.parseInt(value, 8);
  if (!Number.isSafeInteger(parsed) || parsed < 0)
    throw new Error('Invalid tar metadata value.');
  return parsed;
}

const MAX_TAR_MTIME = 0o77777777777;

// Backups created before the supervisor format stored milliseconds. USTAR holds
// seconds in 11 octal digits, so normalise instead of making old backups unrestorable.
export function normalizeMtime(value) {
  if (!Number.isFinite(value) || value < 0) return 0;
  const whole = Math.floor(value);
  const seconds = whole > 40_000_000_000 ? Math.floor(whole / 1000) : whole;
  return Math.min(seconds, MAX_TAR_MTIME);
}

const RESERVED_PREFIXES = ['.opendots-b2-', '.opendots-restore-'];

function isReservedPath(path) {
  return path
    .split('/')
    .some((part) =>
      RESERVED_PREFIXES.some((prefix) => part.startsWith(prefix)),
    );
}

function assertBudget(entries) {
  if (entries.length > ARCHIVE_LIMITS.maxFiles)
    throw new Error('Archive file-count limit exceeded.');
  let total = 0;
  for (const entry of entries) {
    if (!Buffer.isBuffer(entry.data))
      throw new Error('Archive entry payload is not binary data.');
    if (entry.data.length > ARCHIVE_LIMITS.maxSingleFileBytes)
      throw new Error('Archive entry exceeds the per-file limit.');
    total += entry.data.length;
    if (total > ARCHIVE_LIMITS.maxTotalBytes)
      throw new Error('Archive total uncompressed-size limit exceeded.');
  }
}

export function safeArchivePath(rawPath) {
  if (
    typeof rawPath !== 'string' ||
    rawPath.length === 0 ||
    rawPath.length > 4096
  ) {
    throw new Error('Invalid archive path.');
  }
  if (rawPath.includes('\0') || rawPath.includes('\\')) {
    throw new Error('Invalid archive path separator or null byte.');
  }
  if (rawPath.startsWith('/') || /^[A-Za-z]:/.test(rawPath))
    throw new Error('Absolute archive path is not allowed.');
  const segments = rawPath.split('/');
  if (segments.some((part) => !part || part === '.' || part === '..')) {
    throw new Error('Archive path traversal is not allowed.');
  }
  if (isReservedPath(segments.join('/'))) {
    throw new Error('Archive path uses a reserved OpenDots restore name.');
  }
  return segments.join('/');
}

export function encodeOdar(type, entries) {
  if (!BACKUP_TYPES.has(type)) throw new Error('Unsupported backup type.');
  const normalized = entries.map((entry) => ({
    path: safeArchivePath(entry.path),
    data: Buffer.from(entry.data),
    mtime: Number.isFinite(entry.mtime)
      ? normalizeMtime(entry.mtime)
      : Math.floor(Date.now() / 1000),
    mode: Number.isSafeInteger(entry.mode) ? entry.mode & 0o777 : 0o644,
  }));
  assertBudget(normalized);
  const document = {
    magic: 'ODAR',
    version: 1,
    type,
    createdAt: Date.now(),
    files: normalized.map((entry) => ({
      path: entry.path,
      dataBase64: entry.data.toString('base64'),
      size: entry.data.length,
      mtime: entry.mtime,
      mode: entry.mode,
    })),
  };
  const encoded = gzipSync(Buffer.from(JSON.stringify(document), 'utf8'));
  if (encoded.length > ARCHIVE_LIMITS.maxArchiveBytes)
    throw new Error('Encoded backup exceeds the archive-size limit.');
  return encoded;
}

export function decodeOdar(input, expectedType) {
  const packed = Buffer.from(input);
  if (!packed.length || packed.length > ARCHIVE_LIMITS.maxArchiveBytes) {
    throw new Error(
      'Backup payload is empty or exceeds the archive-size limit.',
    );
  }
  let decoded = packed;
  if (packed.length >= 2 && packed[0] === 0x1f && packed[1] === 0x8b) {
    decoded = gunzipSync(packed, { maxOutputLength: 800 * 1024 * 1024 });
  }
  let document;
  try {
    document = JSON.parse(decoded.toString('utf8'));
  } catch {
    throw new Error('Backup archive is not a valid ODAR document.');
  }
  if (document?.magic !== 'ODAR' || document?.version !== 1)
    throw new Error('Unsupported backup archive format.');
  if (!BACKUP_TYPES.has(document.type) || document.type !== expectedType) {
    throw new Error(
      'Backup archive type does not match the requested operation.',
    );
  }
  if (
    !Array.isArray(document.files) ||
    document.files.length > ARCHIVE_LIMITS.maxFiles
  ) {
    throw new Error('Backup archive contains an invalid file list.');
  }
  const entries = document.files.map((file) => {
    const path = safeArchivePath(file?.path);
    if (
      typeof file.dataBase64 !== 'string' ||
      file.dataBase64.length > (ARCHIVE_LIMITS.maxSingleFileBytes * 4) / 3 + 8
    ) {
      throw new Error('Backup archive contains invalid file data.');
    }
    const data = Buffer.from(file.dataBase64, 'base64');
    if (
      data.toString('base64') !== file.dataBase64 ||
      data.length !== file.size
    ) {
      throw new Error(
        'Backup archive file size or base64 encoding is invalid.',
      );
    }
    if (data.length > ARCHIVE_LIMITS.maxSingleFileBytes)
      throw new Error('Backup archive file exceeds the per-file limit.');
    return {
      path,
      data,
      mtime: normalizeMtime(file.mtime),
      mode: Number.isSafeInteger(file.mode) ? file.mode & 0o777 : 0o644,
    };
  });
  assertBudget(entries);
  return entries;
}

function parsePax(buffer) {
  const result = {};
  let offset = 0;
  while (offset < buffer.length) {
    const space = buffer.indexOf(0x20, offset);
    if (space < 0) throw new Error('Malformed tar PAX record.');
    const lengthText = buffer.subarray(offset, space).toString('ascii');
    if (!/^\d+$/.test(lengthText))
      throw new Error('Malformed tar PAX record length.');
    const length = Number.parseInt(lengthText, 10);
    if (
      !Number.isSafeInteger(length) ||
      length <= space - offset + 2 ||
      offset + length > buffer.length
    ) {
      throw new Error('Malformed tar PAX record bounds.');
    }
    const record = buffer
      .subarray(space + 1, offset + length)
      .toString('utf8')
      .replace(/\n$/, '');
    const equals = record.indexOf('=');
    if (equals <= 0) throw new Error('Malformed tar PAX record value.');
    result[record.slice(0, equals)] = record.slice(equals + 1);
    offset += length;
  }
  return result;
}

function stripTarRoot(rawPath, rootPath) {
  let path = rawPath.replace(/^\.\/+/, '');
  const root = rootPath.replace(/^\/+|\/+$/g, '');
  const base = root.split('/').at(-1);
  if (path === root || path === base) return '';
  if (path.startsWith(root + '/')) path = path.slice(root.length + 1);
  else if (path.startsWith(base + '/')) path = path.slice(base.length + 1);
  return path.replace(/\/+$/, '');
}

export function parseTarArchive(input, rootPath, type) {
  const buffer = Buffer.from(input);
  if (!buffer.length || buffer.length > ARCHIVE_LIMITS.maxArchiveBytes) {
    throw new Error('Tar archive is empty or exceeds the archive-size limit.');
  }
  const entries = [];
  let offset = 0;
  let localPax = {};
  let globalPax = {};
  let longName;
  let total = 0;
  while (offset + 512 <= buffer.length) {
    const header = buffer.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    const storedChecksum = octalAt(header, 148, 8);
    const checksumHeader = Buffer.from(header);
    checksumHeader.fill(0x20, 148, 156);
    const actualChecksum = checksumHeader.reduce((sum, byte) => sum + byte, 0);
    if (storedChecksum !== actualChecksum)
      throw new Error('Tar header checksum is invalid.');
    const name = textAt(header, 0, 100);
    const prefix = textAt(header, 345, 155);
    const headerPath = prefix ? prefix + '/' + name : name;
    const mode = octalAt(header, 100, 8) & 0o777;
    const headerSize = octalAt(header, 124, 12);
    const mtime = octalAt(header, 136, 12);
    const typeflag = header[156] === 0 ? '0' : String.fromCharCode(header[156]);
    const contentStart = offset + 512;
    if (
      headerSize > ARCHIVE_LIMITS.maxArchiveBytes ||
      contentStart + headerSize > buffer.length
    ) {
      throw new Error('Tar entry size or bounds are invalid.');
    }
    const payload = buffer.subarray(contentStart, contentStart + headerSize);
    const nextOffset = contentStart + Math.ceil(headerSize / 512) * 512;
    if (typeflag === 'x' || typeflag === 'g') {
      const pax = parsePax(payload);
      if (typeflag === 'g') globalPax = { ...globalPax, ...pax };
      else localPax = { ...localPax, ...pax };
      offset = nextOffset;
      continue;
    }
    if (typeflag === 'L') {
      longName = payload
        .toString('utf8')
        .replace(/\0.*$/s, '')
        .replace(/\n$/, '');
      offset = nextOffset;
      continue;
    }
    if (typeflag === 'K')
      throw new Error('Tar hard-link metadata is not allowed.');
    const entryPath = localPax.path || globalPax.path || longName || headerPath;
    const relativePath = stripTarRoot(entryPath, rootPath);
    localPax = {};
    longName = undefined;
    offset = nextOffset;
    if (!relativePath) continue;
    // Leftover staging or rollback names from an interrupted restore are OpenDots
    // bookkeeping, never user data. Skip them so one crash cannot block every backup.
    if (isReservedPath(relativePath.replace(/^\/+/, ''))) continue;
    const safePath = safeArchivePath(relativePath);
    if (typeflag === '5') continue;
    if (typeflag === '2' || typeflag === '1') {
      const baseName = safePath.split('/').at(-1);
      // Chromium may leave these stale singleton links in the profile root or
      // inside Default. They are process coordination artifacts, not durable data.
      const singleton =
        type === 'browser-profile' &&
        ['SingletonLock', 'SingletonSocket', 'SingletonCookie'].includes(
          baseName,
        );
      if (singleton) continue;
      throw new Error(
        'Symbolic and hard links are not permitted in computer backups.',
      );
    }
    if (typeflag !== '0' && typeflag !== '7')
      throw new Error('Unsupported special file in computer backup.');
    if (headerSize > ARCHIVE_LIMITS.maxSingleFileBytes)
      throw new Error('Tar file exceeds the per-file size limit.');
    total += headerSize;
    if (
      total > ARCHIVE_LIMITS.maxTotalBytes ||
      entries.length >= ARCHIVE_LIMITS.maxFiles
    ) {
      throw new Error('Tar archive exceeds extraction budgets.');
    }
    entries.push({ path: safePath, data: Buffer.from(payload), mtime, mode });
  }
  assertBudget(entries);
  return entries;
}

function writeString(buffer, offset, length, value) {
  const bytes = Buffer.from(value, 'utf8');
  if (bytes.length > length) throw new Error('Tar path field is too long.');
  bytes.copy(buffer, offset);
}

function writeOctal(buffer, offset, length, value) {
  const number = Math.max(0, Math.floor(value));
  const digits = number.toString(8);
  if (digits.length > length - 1)
    throw new Error('Tar numeric field exceeds USTAR limits.');
  buffer.fill(0, offset, offset + length);
  buffer.write(digits.padStart(length - 1, '0'), offset, length - 1, 'ascii');
}

function makeTarHeader(path, entry, size, typeflag = '0') {
  const header = Buffer.alloc(512, 0);
  let name = path;
  let prefix = '';
  if (Buffer.byteLength(name, 'utf8') > 100) {
    const parts = name.split('/');
    let found = false;
    for (let i = parts.length - 1; i > 0; i--) {
      const candidatePrefix = parts.slice(0, i).join('/');
      const candidateName = parts.slice(i).join('/');
      if (
        Buffer.byteLength(candidatePrefix, 'utf8') <= 155 &&
        Buffer.byteLength(candidateName, 'utf8') <= 100
      ) {
        prefix = candidatePrefix;
        name = candidateName;
        found = true;
        break;
      }
    }
    if (!found) throw new Error('Tar path requires an extended PAX record.');
  }
  writeString(header, 0, 100, name);
  writeOctal(
    header,
    100,
    8,
    Number.isSafeInteger(entry.mode) ? entry.mode & 0o777 : 0o644,
  );
  writeOctal(header, 108, 8, 0);
  writeOctal(header, 116, 8, 0);
  writeOctal(header, 124, 12, size);
  writeOctal(
    header,
    136,
    12,
    normalizeMtime(entry.mtime ?? Math.floor(Date.now() / 1000)),
  );
  header.fill(0x20, 148, 156);
  header[156] = typeflag.charCodeAt(0);
  writeString(header, 257, 6, 'ustar\0');
  writeString(header, 263, 2, '00');
  if (prefix) writeString(header, 345, 155, prefix);
  const checksum = header.reduce((sum, byte) => sum + byte, 0);
  header.write(checksum.toString(8).padStart(6, '0'), 148, 6, 'ascii');
  header[154] = 0;
  header[155] = 0x20;
  return header;
}

function paxRecord(key, value) {
  let length = Buffer.byteLength(key + '=' + value + '\n', 'utf8') + 2;
  for (;;) {
    const record = length + ' ' + key + '=' + value + '\n';
    const actual = Buffer.byteLength(record, 'utf8');
    if (actual === length) return Buffer.from(record, 'utf8');
    length = actual;
  }
}

function appendTarFile(chunks, path, entry, index) {
  let usePax = Buffer.byteLength(path, 'utf8') > 255;
  if (!usePax && Buffer.byteLength(path, 'utf8') > 100) {
    const parts = path.split('/');
    usePax = !parts.some(
      (_, i) =>
        i > 0 &&
        Buffer.byteLength(parts.slice(0, i).join('/'), 'utf8') <= 155 &&
        Buffer.byteLength(parts.slice(i).join('/'), 'utf8') <= 100,
    );
  }
  if (usePax) {
    const pax = paxRecord('path', path);
    const paxEntry = {
      path: 'PaxHeaders/' + index,
      mtime: entry.mtime ?? Math.floor(Date.now() / 1000),
    };
    chunks.push(makeTarHeader(paxEntry.path, paxEntry, pax.length, 'x'));
    chunks.push(pax);
    if (pax.length % 512) chunks.push(Buffer.alloc(512 - (pax.length % 512)));
    path = 'PaxFile/' + index;
  }
  chunks.push(makeTarHeader(path, entry, entry.data.length));
  chunks.push(entry.data);
  if (entry.data.length % 512)
    chunks.push(Buffer.alloc(512 - (entry.data.length % 512)));
}

export function createTarArchive(entries) {
  const normalized = entries.map((entry) => ({
    path: safeArchivePath(entry.path),
    data: Buffer.from(entry.data),
    mtime: Number.isFinite(entry.mtime)
      ? normalizeMtime(entry.mtime)
      : Math.floor(Date.now() / 1000),
    mode: Number.isSafeInteger(entry.mode) ? entry.mode & 0o777 : 0o644,
  }));
  assertBudget(normalized);
  const chunks = [];
  normalized.forEach((entry, index) =>
    appendTarFile(chunks, entry.path, entry, index + 1),
  );
  chunks.push(Buffer.alloc(1024));
  const result = Buffer.concat(chunks);
  if (result.length > ARCHIVE_LIMITS.maxArchiveBytes)
    throw new Error('Generated tar archive exceeds the archive-size limit.');
  return result;
}
