import {
  createCipheriv,
  createDecipheriv,
  createHash,
  hkdfSync,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';

export const ODAR_STREAM_V2_MAGIC = Buffer.from('ODAR2S\r\n', 'ascii');
export const ODAR_STREAM_V2_CHUNK_SIZE = 5 * 1024 * 1024;
export const ODAR_STREAM_V2_MAX_CHUNK_SIZE = 16 * 1024 * 1024;
export const ODAR_STREAM_V2_MAX_HEADER_BYTES = 16 * 1024;
export const ODAR_STREAM_V2_DEFAULT_MAX_BYTES = 600 * 1024 * 1024;

const VERSION = 2;
const DATA_FRAME = 0x01;
const FINAL_FRAME = 0xff;
const GCM_TAG_BYTES = 16;
const SALT_BYTES = 16;
const KEY_BYTES = 32;
const NONCE_BYTES = 12;
const MAX_U64 = (1n << 64n) - 1n;
const ARCHIVE_TYPES = new Set([
  'workspace',
  'browser-profile',
  'full-computer',
]);

export type OdarStreamV2ArchiveType =
  'workspace' | 'browser-profile' | 'full-computer';

export interface OdarStreamV2Identity {
  dotId: string;
  backupId: string;
  archiveType: OdarStreamV2ArchiveType;
}

export interface EncryptOdarStreamV2Options {
  /** Logical authenticated frame size. Production defaults to 5 MiB. */
  chunkSize?: number;
  /** Limit the plaintext stream, before framing overhead. */
  maxTotalBytes?: number;
  signal?: AbortSignal;
}

export interface DecryptOdarStreamV2Options {
  /** Maximum decrypted stream size accepted before any frame is yielded. */
  maxTotalBytes?: number;
  signal?: AbortSignal;
}

interface Header extends OdarStreamV2Identity {
  version: 2;
  payloadEncoding: 'gzip-tar-v1';
  chunkSize: number;
  salt: string;
}

function abortIfNeeded(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  if (signal.reason instanceof Error) throw signal.reason;
  throw new Error('ODAR-Stream v2 operation cancelled.');
}

function validateMasterKey(masterKey: Buffer): void {
  if (!Buffer.isBuffer(masterKey) || masterKey.length !== KEY_BYTES) {
    throw new Error('ODAR-Stream v2 requires a 32-byte master key.');
  }
}

function validateIdentity(identity: OdarStreamV2Identity): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(identity.dotId)) {
    throw new Error('ODAR-Stream v2 Dot ID is invalid.');
  }
  if (!/^[A-Za-z0-9_-]{8,64}$/.test(identity.backupId)) {
    throw new Error('ODAR-Stream v2 backup ID is invalid.');
  }
  if (!ARCHIVE_TYPES.has(identity.archiveType)) {
    throw new Error('ODAR-Stream v2 archive type is invalid.');
  }
}

function validateChunkSize(chunkSize: number): void {
  if (
    !Number.isSafeInteger(chunkSize) ||
    chunkSize < 1 ||
    chunkSize > ODAR_STREAM_V2_MAX_CHUNK_SIZE
  ) {
    throw new Error(
      'ODAR-Stream v2 chunk size must be between 1 byte and 16 MiB.',
    );
  }
}

function validateMaxBytes(maxTotalBytes: number): void {
  if (!Number.isSafeInteger(maxTotalBytes) || maxTotalBytes < 0) {
    throw new Error('ODAR-Stream v2 maximum byte count is invalid.');
  }
}

function deriveBackupKey(
  masterKey: Buffer,
  salt: Buffer,
  identity: OdarStreamV2Identity,
): Buffer {
  const info = Buffer.from(
    [
      'OpenDots',
      'ODAR-Stream',
      'v2',
      identity.dotId,
      identity.backupId,
      identity.archiveType,
    ].join('\0'),
    'utf8',
  );
  return Buffer.from(hkdfSync('sha256', masterKey, salt, info, KEY_BYTES));
}

function buildHeader(
  identity: OdarStreamV2Identity,
  salt: Buffer,
  chunkSize: number,
): Header {
  return {
    version: VERSION,
    dotId: identity.dotId,
    backupId: identity.backupId,
    archiveType: identity.archiveType,
    payloadEncoding: 'gzip-tar-v1',
    chunkSize,
    salt: salt.toString('base64'),
  };
}

/** Fixed-order JSON avoids ambiguous encodings in the authenticated header. */
function canonicalHeaderBytes(header: Header): Buffer {
  return Buffer.from(
    JSON.stringify({
      version: header.version,
      dotId: header.dotId,
      backupId: header.backupId,
      archiveType: header.archiveType,
      payloadEncoding: header.payloadEncoding,
      chunkSize: header.chunkSize,
      salt: header.salt,
    }),
    'utf8',
  );
}

function makeHeaderBinding(headerBytes: Buffer): Buffer {
  const binding = Buffer.allocUnsafe(
    ODAR_STREAM_V2_MAGIC.length + 4 + headerBytes.length,
  );
  ODAR_STREAM_V2_MAGIC.copy(binding, 0);
  binding.writeUInt32BE(headerBytes.length, ODAR_STREAM_V2_MAGIC.length);
  headerBytes.copy(binding, ODAR_STREAM_V2_MAGIC.length + 4);
  return binding;
}

function nonceFor(sequence: bigint): Buffer {
  if (sequence < 0n || sequence > MAX_U64) {
    throw new Error('ODAR-Stream v2 frame sequence overflow.');
  }
  const nonce = Buffer.alloc(NONCE_BYTES);
  // The per-backup HKDF key is unique per random salt. Within that key the
  // 96-bit nonce is a monotonically increasing uint64 counter with a zero prefix.
  nonce.writeBigUInt64BE(sequence, 4);
  return nonce;
}

function dataAad(
  headerBinding: Buffer,
  sequence: bigint,
  plaintextLength: number,
): Buffer {
  const aad = Buffer.allocUnsafe(headerBinding.length + 1 + 8 + 4);
  headerBinding.copy(aad, 0);
  let offset = headerBinding.length;
  aad[offset++] = DATA_FRAME;
  aad.writeBigUInt64BE(sequence, offset);
  offset += 8;
  aad.writeUInt32BE(plaintextLength, offset);
  return aad;
}

function finalAad(
  headerBinding: Buffer,
  chunkCount: bigint,
  totalBytes: bigint,
  digest: Buffer,
): Buffer {
  const aad = Buffer.allocUnsafe(
    headerBinding.length + 1 + 8 + 8 + digest.length,
  );
  headerBinding.copy(aad, 0);
  let offset = headerBinding.length;
  aad[offset++] = FINAL_FRAME;
  aad.writeBigUInt64BE(chunkCount, offset);
  offset += 8;
  aad.writeBigUInt64BE(totalBytes, offset);
  offset += 8;
  digest.copy(aad, offset);
  return aad;
}

function encryptDataFrame(
  plaintext: Buffer,
  masterKey: Buffer,
  headerBinding: Buffer,
  derivedKey: Buffer,
  sequence: bigint,
): Buffer {
  const cipher = createCipheriv('aes-256-gcm', derivedKey, nonceFor(sequence), {
    authTagLength: GCM_TAG_BYTES,
  });
  cipher.setAAD(dataAad(headerBinding, sequence, plaintext.length));
  const updated = cipher.update(plaintext);
  const final = cipher.final();
  const ciphertext = final.length ? Buffer.concat([updated, final]) : updated;
  const tag = cipher.getAuthTag();
  const frame = Buffer.allocUnsafe(1 + 8 + 4 + ciphertext.length + tag.length);
  frame[0] = DATA_FRAME;
  frame.writeBigUInt64BE(sequence, 1);
  frame.writeUInt32BE(plaintext.length, 9);
  ciphertext.copy(frame, 13);
  tag.copy(frame, 13 + ciphertext.length);
  // masterKey is intentionally accepted only at the caller boundary. The derived
  // key is the only key passed to the cipher; this reference also catches accidental
  // call-site omission of the validated master-key object during refactors.
  void masterKey;
  return frame;
}

function encryptFinalFrame(
  derivedKey: Buffer,
  headerBinding: Buffer,
  chunkCount: bigint,
  totalBytes: bigint,
  digest: Buffer,
): Buffer {
  const aad = finalAad(headerBinding, chunkCount, totalBytes, digest);
  const cipher = createCipheriv(
    'aes-256-gcm',
    derivedKey,
    nonceFor(chunkCount),
    { authTagLength: GCM_TAG_BYTES },
  );
  cipher.setAAD(aad);
  cipher.final();
  const tag = cipher.getAuthTag();

  const frame = Buffer.allocUnsafe(1 + 8 + 8 + digest.length + tag.length);
  frame[0] = FINAL_FRAME;
  frame.writeBigUInt64BE(chunkCount, 1);
  frame.writeBigUInt64BE(totalBytes, 9);
  digest.copy(frame, 17);
  tag.copy(frame, 17 + digest.length);
  return frame;
}

/**
 * Encrypt an already-compressed, streaming tar archive into ODAR-Stream v2 frames.
 *
 * The generator emits a final authenticated manifest only after the source reaches
 * EOF normally. If the source fails or is cancelled, consumers must abort the target
 * upload and must not treat the partial byte sequence as a valid backup.
 */
export async function* encryptOdarStreamV2(
  source: AsyncIterable<Uint8Array>,
  masterKey: Buffer,
  identity: OdarStreamV2Identity,
  options: EncryptOdarStreamV2Options = {},
): AsyncGenerator<Buffer> {
  validateMasterKey(masterKey);
  validateIdentity(identity);
  const chunkSize = options.chunkSize ?? ODAR_STREAM_V2_CHUNK_SIZE;
  const maxTotalBytes =
    options.maxTotalBytes ?? ODAR_STREAM_V2_DEFAULT_MAX_BYTES;
  validateChunkSize(chunkSize);
  validateMaxBytes(maxTotalBytes);

  const salt = randomBytes(SALT_BYTES);
  const header = buildHeader(identity, salt, chunkSize);
  const headerBytes = canonicalHeaderBytes(header);
  if (headerBytes.length > ODAR_STREAM_V2_MAX_HEADER_BYTES) {
    throw new Error('ODAR-Stream v2 header exceeds the size limit.');
  }
  const headerBinding = makeHeaderBinding(headerBytes);
  const derivedKey = deriveBackupKey(masterKey, salt, identity);
  const digest = createHash('sha256');
  const plaintextChunk = Buffer.allocUnsafe(chunkSize);
  let buffered = 0;
  let totalBytes = 0;
  let sequence = 0n;

  yield headerBinding;

  const emitChunk = (plaintext: Buffer): Buffer => {
    if (sequence > MAX_U64) {
      throw new Error('ODAR-Stream v2 frame sequence overflow.');
    }
    if (totalBytes + plaintext.length > maxTotalBytes) {
      throw new Error('ODAR-Stream v2 plaintext byte limit exceeded.');
    }
    digest.update(plaintext);
    totalBytes += plaintext.length;
    const frame = encryptDataFrame(
      plaintext,
      masterKey,
      headerBinding,
      derivedKey,
      sequence,
    );
    sequence += 1n;
    return frame;
  };

  for await (const inputValue of source) {
    abortIfNeeded(options.signal);
    if (!(inputValue instanceof Uint8Array)) {
      throw new Error('ODAR-Stream v2 source yielded a non-binary chunk.');
    }
    const input = Buffer.from(inputValue);
    let offset = 0;
    while (offset < input.length) {
      abortIfNeeded(options.signal);
      const copyLength = Math.min(chunkSize - buffered, input.length - offset);
      input.copy(plaintextChunk, buffered, offset, offset + copyLength);
      buffered += copyLength;
      offset += copyLength;

      if (buffered === chunkSize) {
        const frame = emitChunk(plaintextChunk.subarray(0, buffered));
        buffered = 0;
        yield frame;
      }
    }
  }

  abortIfNeeded(options.signal);
  if (buffered > 0) {
    yield emitChunk(plaintextChunk.subarray(0, buffered));
  }
  const finalDigest = digest.digest();
  yield encryptFinalFrame(
    derivedKey,
    headerBinding,
    sequence,
    BigInt(totalBytes),
    finalDigest,
  );
}

/**
 * Decrypt and authenticate ODAR-Stream v2. Every individual chunk is authenticated
 * before it is yielded, but consumers MUST write to isolated staging and wait for
 * this generator to finish normally (including final-manifest and EOF validation)
 * before committing any restored state to live files.
 */
export async function* decryptOdarStreamV2(
  source: AsyncIterable<Uint8Array>,
  masterKey: Buffer,
  expectedIdentity: Partial<OdarStreamV2Identity> = {},
  options: DecryptOdarStreamV2Options = {},
): AsyncGenerator<Buffer> {
  validateMasterKey(masterKey);
  const maxTotalBytes =
    options.maxTotalBytes ?? ODAR_STREAM_V2_DEFAULT_MAX_BYTES;
  validateMaxBytes(maxTotalBytes);

  const reader = new ByteReader(source, options.signal);
  const magic = await reader.readExactly(ODAR_STREAM_V2_MAGIC.length);
  if (!magic.equals(ODAR_STREAM_V2_MAGIC)) {
    throw new Error('ODAR-Stream v2 magic/header is invalid.');
  }
  const headerLengthBytes = await reader.readExactly(4);
  const headerLength = headerLengthBytes.readUInt32BE(0);
  if (headerLength < 2 || headerLength > ODAR_STREAM_V2_MAX_HEADER_BYTES) {
    throw new Error('ODAR-Stream v2 header length is invalid.');
  }
  const headerBytes = await reader.readExactly(headerLength);
  const header = parseHeader(headerBytes);

  for (const key of ['dotId', 'backupId', 'archiveType'] as const) {
    const expected = expectedIdentity[key];
    if (expected !== undefined && expected !== header[key]) {
      throw new Error(
        `ODAR-Stream v2 ${key} does not match the requested backup.`,
      );
    }
  }

  const identity: OdarStreamV2Identity = {
    dotId: header.dotId,
    backupId: header.backupId,
    archiveType: header.archiveType,
  };
  const salt = Buffer.from(header.salt, 'base64');
  const derivedKey = deriveBackupKey(masterKey, salt, identity);
  const headerBinding = makeHeaderBinding(headerBytes);
  const digest = createHash('sha256');
  let expectedSequence = 0n;
  let totalBytes = 0;

  for (;;) {
    abortIfNeeded(options.signal);
    const frameType = (await reader.readExactly(1))[0];

    if (frameType === DATA_FRAME) {
      const sequenceBytes = await reader.readExactly(8);
      const sequence = sequenceBytes.readBigUInt64BE(0);
      const lengthBytes = await reader.readExactly(4);
      const plaintextLength = lengthBytes.readUInt32BE(0);

      if (sequence !== expectedSequence) {
        throw new Error(
          'ODAR-Stream v2 data frames are missing, repeated or out of order.',
        );
      }
      if (plaintextLength < 1 || plaintextLength > header.chunkSize) {
        throw new Error('ODAR-Stream v2 frame length is invalid.');
      }
      if (totalBytes + plaintextLength > maxTotalBytes) {
        throw new Error('ODAR-Stream v2 plaintext byte limit exceeded.');
      }

      const ciphertext = await reader.readExactly(plaintextLength);
      const tag = await reader.readExactly(GCM_TAG_BYTES);
      const decipher = createDecipheriv(
        'aes-256-gcm',
        derivedKey,
        nonceFor(sequence),
        { authTagLength: GCM_TAG_BYTES },
      );
      decipher.setAAD(dataAad(headerBinding, sequence, plaintextLength));
      decipher.setAuthTag(tag);

      let plaintext: Buffer;
      try {
        const updated = decipher.update(ciphertext);
        const final = decipher.final();
        plaintext = final.length ? Buffer.concat([updated, final]) : updated;
      } catch {
        throw new Error('ODAR-Stream v2 data frame authentication failed.');
      }

      if (plaintext.length !== plaintextLength) {
        throw new Error('ODAR-Stream v2 decrypted frame length is invalid.');
      }
      digest.update(plaintext);
      totalBytes += plaintext.length;
      expectedSequence += 1n;
      yield plaintext;
      continue;
    }

    if (frameType !== FINAL_FRAME) {
      throw new Error('ODAR-Stream v2 contains an unknown frame type.');
    }

    const countBytes = await reader.readExactly(8);
    const chunkCount = countBytes.readBigUInt64BE(0);
    const totalBytesField = await reader.readExactly(8);
    const declaredTotalBytes = totalBytesField.readBigUInt64BE(0);
    const declaredDigest = await reader.readExactly(32);
    const tag = await reader.readExactly(GCM_TAG_BYTES);

    if (chunkCount !== expectedSequence) {
      throw new Error('ODAR-Stream v2 final manifest chunk count is invalid.');
    }
    if (declaredTotalBytes !== BigInt(totalBytes)) {
      throw new Error('ODAR-Stream v2 final manifest byte count is invalid.');
    }
    const actualDigest = digest.digest();
    if (!timingSafeEqual(declaredDigest, actualDigest)) {
      throw new Error('ODAR-Stream v2 final manifest digest is invalid.');
    }

    const decipher = createDecipheriv(
      'aes-256-gcm',
      derivedKey,
      nonceFor(chunkCount),
      { authTagLength: GCM_TAG_BYTES },
    );
    decipher.setAAD(
      finalAad(headerBinding, chunkCount, declaredTotalBytes, declaredDigest),
    );
    decipher.setAuthTag(tag);
    try {
      decipher.final();
    } catch {
      throw new Error('ODAR-Stream v2 final manifest authentication failed.');
    }

    await reader.assertEof();
    return;
  }
}

function parseHeader(rawHeader: Buffer): Header {
  let value: unknown;
  try {
    value = JSON.parse(rawHeader.toString('utf8'));
  } catch {
    throw new Error('ODAR-Stream v2 header JSON is invalid.');
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('ODAR-Stream v2 header shape is invalid.');
  }

  const record = value as Record<string, unknown>;
  const expectedKeys = [
    'archiveType',
    'backupId',
    'chunkSize',
    'dotId',
    'payloadEncoding',
    'salt',
    'version',
  ];
  const actualKeys = Object.keys(record).sort();
  if (
    actualKeys.length !== expectedKeys.length ||
    actualKeys.some((key, index) => key !== expectedKeys[index])
  ) {
    throw new Error(
      'ODAR-Stream v2 header contains missing or unknown fields.',
    );
  }
  if (
    record.version !== VERSION ||
    typeof record.dotId !== 'string' ||
    typeof record.backupId !== 'string' ||
    typeof record.archiveType !== 'string' ||
    record.payloadEncoding !== 'gzip-tar-v1' ||
    typeof record.salt !== 'string' ||
    typeof record.chunkSize !== 'number'
  ) {
    throw new Error('ODAR-Stream v2 header fields are invalid.');
  }

  const identity = {
    dotId: record.dotId,
    backupId: record.backupId,
    archiveType: record.archiveType as OdarStreamV2ArchiveType,
  };
  validateIdentity(identity);
  validateChunkSize(record.chunkSize);

  const salt = Buffer.from(record.salt, 'base64');
  if (salt.length !== SALT_BYTES || salt.toString('base64') !== record.salt) {
    throw new Error('ODAR-Stream v2 salt encoding is invalid.');
  }

  const header: Header = {
    version: VERSION,
    dotId: identity.dotId,
    backupId: identity.backupId,
    archiveType: identity.archiveType,
    payloadEncoding: 'gzip-tar-v1',
    chunkSize: record.chunkSize,
    salt: record.salt,
  };
  if (!canonicalHeaderBytes(header).equals(rawHeader)) {
    throw new Error('ODAR-Stream v2 header is not canonically encoded.');
  }
  return header;
}

class ByteReader {
  private readonly iterator: AsyncIterator<Uint8Array>;
  private current = Buffer.alloc(0);
  private offset = 0;
  private ended = false;

  constructor(
    source: AsyncIterable<Uint8Array>,
    private readonly signal?: AbortSignal,
  ) {
    this.iterator = source[Symbol.asyncIterator]();
  }

  async readExactly(length: number): Promise<Buffer> {
    abortIfNeeded(this.signal);
    if (!Number.isSafeInteger(length) || length < 0) {
      throw new Error('ODAR-Stream v2 requested an invalid read length.');
    }
    const result = Buffer.allocUnsafe(length);
    let written = 0;

    while (written < length) {
      abortIfNeeded(this.signal);
      if (this.offset >= this.current.length) {
        if (this.ended) {
          throw new Error('ODAR-Stream v2 stream is truncated.');
        }
        const next = await this.iterator.next();
        if (next.done) {
          this.ended = true;
          throw new Error('ODAR-Stream v2 stream is truncated.');
        }
        this.current = Buffer.from(next.value);
        this.offset = 0;
        if (this.current.length === 0) continue;
      }

      const copyLength = Math.min(
        length - written,
        this.current.length - this.offset,
      );
      this.current.copy(result, written, this.offset, this.offset + copyLength);
      this.offset += copyLength;
      written += copyLength;
    }
    return result;
  }

  async assertEof(): Promise<void> {
    abortIfNeeded(this.signal);
    if (this.offset < this.current.length) {
      throw new Error(
        'ODAR-Stream v2 has trailing bytes after the final manifest.',
      );
    }
    while (!this.ended) {
      const next = await this.iterator.next();
      if (next.done) {
        this.ended = true;
        return;
      }
      if (next.value.length > 0) {
        throw new Error(
          'ODAR-Stream v2 has trailing bytes after the final manifest.',
        );
      }
    }
  }
}
