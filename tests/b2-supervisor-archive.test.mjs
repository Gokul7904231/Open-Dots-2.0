/* global Buffer */
import { describe, expect, it } from 'vitest';
import {
  createTarArchive,
  decodeOdar,
  encodeOdar,
  encodeTarGzip,
  parseTarArchive,
  safeArchivePath,
} from '../deployment/computers/b2-archive-format.mjs';
import {
  hardenSupervisorEnvironment,
  hardenSupervisorIndex,
} from '../deployment/computers/harden-supervisor.mjs';

describe('supervisor archive format', () => {
  it('round-trips binary workspace files through ODAR', () => {
    const expected = Buffer.from([0, 1, 2, 127, 128, 254, 255]);
    const packed = encodeOdar('workspace', [
      {
        path: 'src/binary.bin',
        data: expected,
        mtime: 1_700_000_000,
        mode: 0o755,
      },
    ]);
    const decoded = decodeOdar(packed, 'workspace');
    expect(decoded).toHaveLength(1);
    expect(decoded[0].path).toBe('src/binary.bin');
    expect(decoded[0].data).toEqual(expected);
    expect(decoded[0].mtime).toBe(1_700_000_000);
    expect(decoded[0].mode).toBe(0o755);
  });

  it('round-trips binary workspace files through gzip-tar-v1 in decodeOdar', () => {
    const expected = Buffer.from([0, 1, 2, 127, 128, 254, 255]);
    const packed = encodeTarGzip('workspace', [
      {
        path: 'src/binary.bin',
        data: expected,
        mtime: 1_700_000_000,
        mode: 0o755,
      },
    ]);
    const decoded = decodeOdar(packed, 'workspace');
    expect(decoded).toHaveLength(1);
    expect(decoded[0].path).toBe('src/binary.bin');
    expect(decoded[0].data).toEqual(expected);
    expect(decoded[0].mtime).toBe(1_700_000_000);
    expect(decoded[0].mode).toBe(0o755);
  });

  it('round-trips tar files, including paths that require a PAX header', () => {
    const data = Buffer.from([0, 9, 10, 13, 127, 255]);
    const longPath = 'x'.repeat(130);
    const tar = createTarArchive([
      { path: 'workspace/marker.bin', data, mtime: 1_700_000_000, mode: 0o755 },
      { path: longPath, data: Buffer.from('long path') },
    ]);
    const decoded = parseTarArchive(tar, '/workspace', 'workspace');
    expect(decoded.map((entry) => entry.path)).toEqual([
      'marker.bin',
      longPath,
    ]);
    expect(decoded[0].data).toEqual(data);
    expect(decoded[0].mode).toBe(0o755);
    expect(decoded[1].data.toString('utf8')).toBe('long path');
  });

  it('rejects traversal, absolute paths, and reserved staging names', () => {
    expect(() => safeArchivePath('../escape')).toThrow();
    expect(() => safeArchivePath('/absolute/path')).toThrow();
    expect(() => safeArchivePath('C:/Windows/file')).toThrow();
    expect(() => safeArchivePath('.opendots-b2-rollback-x/file')).toThrow();
  });

  it('normalises legacy millisecond timestamps instead of overflowing tar headers', () => {
    const packed = encodeOdar('workspace', [
      { path: 'legacy.txt', data: Buffer.from('x'), mtime: 1_792_441_559_000 },
    ]);
    const [entry] = decodeOdar(packed, 'workspace');
    expect(entry.mtime).toBe(1_792_441_559);
    const [roundTripped] = parseTarArchive(
      createTarArchive([entry]),
      '/__none__',
      'workspace',
    );
    expect(roundTripped.mtime).toBe(1_792_441_559);
  });

  it('fails closed if the pinned supervisor environment contract changes', () => {
    expect(() =>
      hardenSupervisorEnvironment('const different = true;'),
    ).toThrow(/contract changed/);
  });

  it('patches each anchor exactly once and never interprets $ sequences', () => {
    // Shape test over a minimal stand-in. The patch against the REAL pinned OpenBot
    // source is exercised by scripts/verify-supervisor-patch.mjs.
    const source = [
      'import { listenPort } from "./listen-port";',
      'app.get("/health", async (context) =>',
      'serve({ port, fetch: app.fetch, idleTimeout: 120 });',
    ].join('\n');
    const patched = hardenSupervisorIndex(source);
    expect(patched).toContain(
      'import { attachBackupRoutes, lifecycleGuard } from "./b2-archive-supervisor.mjs";',
    );
    expect(patched.indexOf('app.use("*", lifecycleGuard);')).toBeLessThan(
      patched.indexOf('app.get("/health"'),
    );
    expect(patched).toContain('attachBackupRoutes(app, resolve);');
    expect(patched).toContain('maxRequestBodySize: 600 * 1024 * 1024');
    expect(patched).not.toContain('idleTimeout: 120');
    expect(() => hardenSupervisorIndex(patched + '\n' + source)).toThrow(
      /contract changed/,
    );
  });

  it('fails closed if the pinned supervisor index contract changes', () => {
    expect(() => hardenSupervisorIndex('serve(app);')).toThrow(
      /contract changed/,
    );
  });
});
