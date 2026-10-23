import { Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import {
  ODAR_STREAM_V2_MAGIC,
  decryptOdarStreamV2,
  encryptOdarStreamV2,
} from '../src/server/backup/odar-stream-v2.js';

const key = Buffer.from('9f'.repeat(32), 'hex');
const identity = {
  dotId: 'dot-alpha',
  backupId: 'backup_12345678',
  archiveType: 'workspace' as const,
};

async function* fragment(
  value: Uint8Array,
  sizes: number[] = [1, 7, 3, 19, 2, 31],
): AsyncGenerator<Buffer> {
  let offset = 0;
  let index = 0;
  while (offset < value.length) {
    const length = sizes[index % sizes.length]!;
    const end = Math.min(offset + length, value.length);
    yield Buffer.from(value.subarray(offset, end));
    offset = end;
    index += 1;
  }
}

async function collect(source: AsyncIterable<Uint8Array>): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of source) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

async function decode(
  stream: Uint8Array,
  expected = identity,
  masterKey = key,
): Promise<Buffer> {
  return collect(
    decryptOdarStreamV2(fragment(stream), masterKey, expected, {
      maxTotalBytes: 1024 * 1024,
    }),
  );
}

describe('ODAR-Stream v2 framing', () => {
  it('round-trips a fragmented source and fragmented encoded stream', async () => {
    const original = Buffer.from(
      Array.from({ length: 8193 }, (_, index) => (index * 31) % 256),
    );
    const encoded = await collect(
      encryptOdarStreamV2(fragment(original), key, identity, {
        chunkSize: 257,
        maxTotalBytes: 16 * 1024,
      }),
    );

    expect(encoded.subarray(0, ODAR_STREAM_V2_MAGIC.length)).toEqual(
      ODAR_STREAM_V2_MAGIC,
    );
    await expect(decode(encoded)).resolves.toEqual(original);
  });

  it('authenticates every data frame before yielding its plaintext', async () => {
    const original = Buffer.from('authenticated chunk payload '.repeat(8));
    const encoded = await collect(
      encryptOdarStreamV2(fragment(original), key, identity, {
        chunkSize: 32,
        maxTotalBytes: 1024,
      }),
    );
    const headerLength = encoded.readUInt32BE(ODAR_STREAM_V2_MAGIC.length);
    const firstFrame = ODAR_STREAM_V2_MAGIC.length + 4 + headerLength;
    encoded[firstFrame + 13] ^= 0x01;

    await expect(decode(encoded)).rejects.toThrow(
      /data frame authentication failed/,
    );
  });

  it('rejects a backup identity mismatch before decoding the payload', async () => {
    const encoded = await collect(
      encryptOdarStreamV2(fragment(Buffer.from('payload')), key, identity, {
        chunkSize: 8,
      }),
    );

    await expect(
      decode(encoded, { ...identity, dotId: 'other-dot' }),
    ).rejects.toThrow(/dotId does not match/);
  });

  it('rejects truncated data or a missing final manifest', async () => {
    const encoded = await collect(
      encryptOdarStreamV2(
        fragment(Buffer.from('payload'.repeat(40))),
        key,
        identity,
        {
          chunkSize: 17,
        },
      ),
    );

    await expect(
      decode(encoded.subarray(0, encoded.length - 1)),
    ).rejects.toThrow(
      /truncated|manifest authentication failed|final manifest/i,
    );
  });

  it('rejects a corrupt final-manifest tag', async () => {
    const encoded = await collect(
      encryptOdarStreamV2(fragment(Buffer.from('payload')), key, identity, {
        chunkSize: 64,
      }),
    );
    encoded[encoded.length - 1] ^= 0x01;

    await expect(decode(encoded)).rejects.toThrow(
      /final manifest authentication failed/,
    );
  });

  it('rejects out-of-order or repeated data-frame sequence numbers', async () => {
    const encoded = await collect(
      encryptOdarStreamV2(
        fragment(Buffer.from('abcdefghijklmnop')),
        key,
        identity,
        {
          chunkSize: 4,
        },
      ),
    );
    const headerLength = encoded.readUInt32BE(ODAR_STREAM_V2_MAGIC.length);
    const firstFrame = ODAR_STREAM_V2_MAGIC.length + 4 + headerLength;
    const firstFrameBytes = 1 + 8 + 4 + 4 + 16;
    const secondFrame = firstFrame + firstFrameBytes;
    encoded.writeBigUInt64BE(0n, secondFrame + 1);

    await expect(decode(encoded)).rejects.toThrow(
      /missing, repeated or out of order/,
    );
  });

  it('rejects trailing bytes after an otherwise valid final manifest', async () => {
    const encoded = await collect(
      encryptOdarStreamV2(fragment(Buffer.from('payload')), key, identity),
    );
    const withTrailingByte = Buffer.concat([encoded, Buffer.from([0])]);

    await expect(decode(withTrailingByte)).rejects.toThrow(/trailing bytes/);
  });

  it('rejects a wrong encryption key', async () => {
    const encoded = await collect(
      encryptOdarStreamV2(
        fragment(Buffer.from('secret payload')),
        key,
        identity,
        {
          chunkSize: 8,
        },
      ),
    );
    const wrongKey = Buffer.alloc(32, 0x33);

    await expect(decode(encoded, identity, wrongKey)).rejects.toThrow(
      /authentication failed/,
    );
  });

  it('supports a correctly authenticated empty stream', async () => {
    const encoded = await collect(
      encryptOdarStreamV2(Readable.from([]), key, identity, { chunkSize: 128 }),
    );

    await expect(decode(encoded)).resolves.toEqual(Buffer.alloc(0));
  });
});
