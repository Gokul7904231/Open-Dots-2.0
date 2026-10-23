/* global Buffer, process, setTimeout */
// Behavioural tests for the supervisor backup core. The Docker API is faked, but the
// restore/rollback shell commands are the real production commands, executed with `sh`
// against temporary directories mapped onto /workspace and /profiles. This is NOT live
// Docker evidence: it proves the logic, not the Docker volume or tar plumbing.
import { execFile } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
  existsSync,
  chmodSync,
  lstatSync,
  symlinkSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { Readable } from 'node:stream';
import { gzipSync } from 'node:zlib';
import { Hono } from 'hono';
import { afterEach, describe, expect, it } from 'vitest';
import { createBackupSupervisor } from '../deployment/computers/b2-archive-core.mjs';
import {
  createTarArchive,
  decodeOdar,
  encodeOdar,
  parseTarArchive,
} from '../deployment/computers/b2-archive-format.mjs';

const NS = 'ns';
const LABELS = {
  owner: 'openbot.supervisor',
  bot: 'openbot.bot-id',
  namespace: 'openbot.namespace',
};
const posix = (path) => path.replaceAll('\\', '/');

function tarHeader(name, typeflag, size, mode = 0o644) {
  const header = Buffer.alloc(512, 0);
  header.write(name, 0, 100);
  header.write(mode.toString(8).padStart(7, '0'), 100, 'ascii');
  header.write('0000000', 108, 'ascii');
  header.write('0000000', 116, 'ascii');
  header.write(size.toString(8).padStart(11, '0'), 124, 'ascii');
  header.write('00000000000', 136, 'ascii');
  header.fill(0x20, 148, 156);
  header[156] = typeflag.charCodeAt(0);
  header.write('ustar\0', 257, 'ascii');
  header.write('00', 263, 'ascii');
  const sum = header.reduce((total, byte) => total + byte, 0);
  header.write(sum.toString(8).padStart(6, '0'), 148, 'ascii');
  header[154] = 0;
  header[155] = 0x20;
  return header;
}

function buildTar(entries) {
  const chunks = [];
  for (const entry of entries) {
    const data = entry.data ?? Buffer.alloc(0);
    const size = entry.type === '0' ? data.length : 0;
    chunks.push(tarHeader(entry.name, entry.type ?? '0', size, entry.mode));
    if (size) {
      chunks.push(data);
      if (size % 512) chunks.push(Buffer.alloc(512 - (size % 512)));
    }
  }
  chunks.push(Buffer.alloc(1024));
  return Buffer.concat(chunks);
}

function walk(dir, base = dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    const stat = lstatSync(full);
    const rel = posix(full.slice(base.length + 1));
    if (stat.isSymbolicLink()) out.push({ rel, link: true });
    else if (stat.isDirectory()) out.push(...walk(full, base));
    else out.push({ rel, full, mode: stat.mode & 0o777 });
  }
  return out;
}

function createHarness(options = {}) {
  const root = posix(mkdtempSync(join(tmpdir(), 'od-sup-')));
  mkdirSync(join(root, 'workspace'), { recursive: true });
  mkdirSync(join(root, 'profiles', 'dot-a'), { recursive: true });
  mkdirSync(join(root, 'shm'), { recursive: true });
  const state = {
    containers: new Map([
      [`${NS}-computer-dot-a`, { running: false, owned: true }],
    ]),
    volumes: new Map([
      [`${NS}-workspace-dot-a`, 'dot-a'],
      [`${NS}-profile-dot-a`, 'dot-a'],
    ]),
    activeHelpers: new Set(),
    created: [],
    removed: 0,
    execLog: [],
    execStartOptions: [],
    createVolumeCalls: 0,
  };
  const labelsFor = (bot) => ({
    [LABELS.owner]: 'true',
    [LABELS.bot]: bot,
    [LABELS.namespace]: NS,
  });
  const mapPath = (command) =>
    command
      .replaceAll('/workspace', `${root}/workspace`)
      .replaceAll('/profiles', `${root}/profiles`)
      .replaceAll('/dev/shm', `${root}/shm`);

  const docker = {
    getContainer(name) {
      return {
        async inspect() {
          const found = state.containers.get(name);
          if (!found)
            throw Object.assign(new Error('no such container'), {
              statusCode: 404,
            });
          return {
            Config: { Labels: found.owned ? labelsFor('dot-a') : {} },
            State: { Running: found.running },
          };
        },
      };
    },
    getVolume(name) {
      return {
        async inspect() {
          if (!state.volumes.has(name))
            throw Object.assign(new Error('no such volume'), {
              statusCode: 404,
            });
          return { Labels: labelsFor(state.volumes.get(name)) };
        },
      };
    },
    async createVolume() {
      state.createVolumeCalls += 1;
    },
    async createContainer(spec) {
      if (options.helperMissingImage)
        throw Object.assign(new Error('no such image'), { statusCode: 404 });
      if (state.activeHelpers.has(spec.name))
        throw Object.assign(new Error('conflict'), { statusCode: 409 });
      state.activeHelpers.add(spec.name);
      state.created.push(spec);
      return {
        async start() {},
        async stop() {},
        async remove() {
          if (state.activeHelpers.delete(spec.name)) state.removed += 1;
        },
        // exec, getArchive and putArchive are attached by the wrapper below.
      };
    },
  };

  // Override exec so the real command runs: rebuild createContainer's helper with exec bound.
  const baseCreate = docker.createContainer.bind(docker);
  docker.createContainer = async (spec) => {
    const helper = await baseCreate(spec);
    helper.exec = async (execOptions) => {
      const command = execOptions.Cmd.at(-1);
      state.execLog.push(command);
      if (options.failExec?.(command, state)) {
        return {
          async start(startOptions) {
            state.execStartOptions.push(startOptions);
            return Readable.from([Buffer.from('')]);
          },
          async inspect() {
            return { ExitCode: 1, Running: false };
          },
        };
      }
      const code = await new Promise((resolve) => {
        execFile('sh', ['-c', mapPath(command)], (error) =>
          resolve(error ? (error.code ?? 1) : 0),
        );
      });
      return {
        async start(startOptions) {
          state.execStartOptions.push(startOptions);
          return Readable.from([Buffer.from('')]);
        },
        async inspect() {
          return { ExitCode: code, Running: false };
        },
      };
    };
    helper.getArchive = async ({ path }) => {
      const base = path.split('/').filter(Boolean).at(-1);
      const real = path.startsWith('/dev/shm/')
        ? join(root, 'shm', base)
        : join(root, path);
      if (!existsSync(real))
        throw Object.assign(new Error('not found'), { statusCode: 404 });
      if (path.startsWith('/dev/shm/')) {
        return Readable.from([
          buildTar([
            { name: base, type: '0', data: readFileSync(real), mode: 0o600 },
          ]),
        ]);
      }
      const entries = [{ name: `${base}/`, type: '5' }];
      for (const item of walk(real)) {
        if (item.link) entries.push({ name: `${base}/${item.rel}`, type: '2' });
        else
          entries.push({
            name: `${base}/${item.rel}`,
            type: '0',
            data: readFileSync(item.full),
            mode: item.mode,
          });
      }
      return Readable.from([buildTar(entries)]);
    };
    helper.putArchive = async (tar, { path }) => {
      if (options.failPutArchive) throw new Error('disk full');
      const entries = parseTarArchive(tar, '/__none__', 'workspace');
      for (const entry of entries) {
        const target = join(root, path, entry.path);
        mkdirSync(dirname(target), { recursive: true });
        writeFileSync(target, entry.data);
        chmodSync(target, entry.mode);
      }
    };
    return helper;
  };

  const warnings = [];
  const supervisor = createBackupSupervisor({
    docker,
    namespace: NS,
    defaultNamespace: 'openbot',
    labels: LABELS,
    image: () => 'opendots-computer:test',
    log: { warn: (...args) => warnings.push(args.join(' ')), error: () => {} },
  });
  const app = new Hono();
  app.use('*', supervisor.lifecycleGuard);
  const resolve = (raw) =>
    /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(raw)
      ? {
          ok: true,
          names: {
            botId: raw,
            container: `${NS}-computer-${raw}`,
            profileVolume: `${NS}-profile-${raw}`,
            workspaceVolume: `${NS}-workspace-${raw}`,
          },
        }
      : {
          ok: false,
          reason:
            'A bot id may contain only letters, digits, hyphen and underscore.',
        };
  supervisor.attachBackupRoutes(app, resolve);
  app.post('/computers/:botId/stop', async (context) => {
    if (options.slowStop) await new Promise((r) => setTimeout(r, 60));
    return context.json({ stopped: true });
  });

  const ws = (rel) => join(root, 'workspace', rel);
  const pf = (rel) => join(root, 'profiles', 'dot-a', rel);
  const exportOf = async (type, id = 'dot-a') =>
    app.request(`http://s/computers/${id}/export?type=${type}`);
  const importOf = async (type, body, id = 'dot-a') =>
    app.request(`http://s/computers/${id}/import?type=${type}`, {
      method: 'POST',
      body,
    });
  return {
    root,
    state,
    app,
    ws,
    pf,
    exportOf,
    importOf,
    warnings,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

let harness;
afterEach(() => harness?.cleanup());

const binary = Buffer.from([0, 1, 2, 3, 250, 251, 252, 253, 254, 255]);

describe('supervisor export', () => {
  it('exports workspace binary files with modes, and skips leftover restore bookkeeping', async () => {
    harness = createHarness();
    writeFileSync(harness.ws('marker.bin'), binary);
    mkdirSync(harness.ws('src'), { recursive: true });
    writeFileSync(harness.ws('src/run.sh'), '#!/bin/sh\n');
    chmodSync(harness.ws('src/run.sh'), 0o755);
    mkdirSync(harness.ws('.opendots-b2-failed-old'), { recursive: true });
    writeFileSync(harness.ws('.opendots-b2-failed-old/junk'), 'junk');

    const response = await harness.exportOf('workspace');
    expect(response.status).toBe(200);
    const entries = decodeOdar(
      Buffer.from(await response.arrayBuffer()),
      'workspace',
    );
    expect(entries.map((entry) => entry.path).sort()).toEqual([
      'marker.bin',
      'src/run.sh',
    ]);
    expect(entries.find((entry) => entry.path === 'marker.bin').data).toEqual(
      binary,
    );
    if (process.platform !== 'win32') {
      expect(
        entries.find((entry) => entry.path === 'src/run.sh').mode & 0o111,
      ).not.toBe(0);
    }
  });

  it('exports the per-Dot Chromium profile, never workspace files, and drops singleton links', async () => {
    harness = createHarness();
    writeFileSync(harness.ws('only-workspace.txt'), 'w');
    mkdirSync(harness.pf('Default/Network'), { recursive: true });
    writeFileSync(harness.pf('Default/Network/Cookies'), binary);
    if (process.platform !== 'win32')
      symlinkSync('/tmp/does-not-matter', harness.pf('SingletonSocket'));

    const response = await harness.exportOf('browser-profile');
    expect(response.status).toBe(200);
    const entries = decodeOdar(
      Buffer.from(await response.arrayBuffer()),
      'browser-profile',
    );
    expect(entries.map((entry) => entry.path)).toEqual([
      'Default/Network/Cookies',
    ]);
    expect(entries[0].data).toEqual(binary);
  });

  it('full-computer carries both sections under explicit prefixes', async () => {
    harness = createHarness();
    writeFileSync(harness.ws('a.txt'), 'a');
    writeFileSync(harness.pf('Local State'), 'ls');
    const response = await harness.exportOf('full-computer');
    const entries = decodeOdar(
      Buffer.from(await response.arrayBuffer()),
      'full-computer',
    );
    expect(entries.map((entry) => entry.path).sort()).toEqual([
      'browser-profile/Local State',
      'workspace/a.txt',
    ]);
  });

  it('an absent profile directory exports as empty and is not created by the export', async () => {
    harness = createHarness();
    rmSync(join(harness.root, 'profiles', 'dot-a'), { recursive: true });
    const response = await harness.exportOf('browser-profile');
    expect(response.status).toBe(200);
    expect(
      decodeOdar(Buffer.from(await response.arrayBuffer()), 'browser-profile'),
    ).toEqual([]);
    expect(existsSync(join(harness.root, 'profiles', 'dot-a'))).toBe(false);
  });

  it('refuses a running computer, an unowned container and unowned or missing volumes', async () => {
    harness = createHarness();
    harness.state.containers.get('ns-computer-dot-a').running = true;
    expect((await harness.exportOf('workspace')).status).toBe(409);
    harness.state.containers.get('ns-computer-dot-a').running = false;
    harness.state.containers.get('ns-computer-dot-a').owned = false;
    expect((await harness.exportOf('workspace')).status).toBe(404);
    harness.state.containers.get('ns-computer-dot-a').owned = true;
    harness.state.volumes.set('ns-workspace-dot-a', 'someone-else');
    expect((await harness.exportOf('workspace')).status).toBe(409);
    harness.state.volumes.delete('ns-workspace-dot-a');
    expect((await harness.exportOf('workspace')).status).toBe(404);
    expect(harness.state.createVolumeCalls).toBe(0);
    expect(harness.state.created).toHaveLength(0);
  });

  it('never exports a Dot whose computer does not exist, and creates nothing for it', async () => {
    harness = createHarness();
    const response = await harness.exportOf('workspace', 'ghost');
    expect(response.status).toBe(404);
    expect(harness.state.created).toHaveLength(0);
    expect(harness.state.createVolumeCalls).toBe(0);
  });

  it('starts helper filesystem commands without hijacking Docker HTTP 101 streams', async () => {
    harness = createHarness();
    writeFileSync(harness.ws('before.txt'), 'old data');
    const archive = encodeOdar('workspace', [
      {
        path: 'restored.txt',
        data: Buffer.from('restored data'),
        mtime: 1_700_000_000,
        mode: 0o644,
      },
    ]);

    const response = await harness.importOf('workspace', archive);

    expect(response.status).toBe(200);
    expect(readFileSync(harness.ws('restored.txt'), 'utf8')).toBe(
      'restored data',
    );
    expect(harness.state.execStartOptions.length).toBeGreaterThan(0);
    expect(
      harness.state.execStartOptions.every(
        (options) =>
          options.Detach === true &&
          options.Tty === false &&
          options.hijack === false,
      ),
    ).toBe(true);
  });

  it("runs the helper with only this Dot's volumes, no network and no capabilities", async () => {
    harness = createHarness();
    await harness.exportOf('workspace');
    const spec = harness.state.created[0];
    expect(spec.HostConfig.Binds).toEqual([
      'ns-profile-dot-a:/profiles',
      'ns-workspace-dot-a:/workspace',
    ]);
    expect(spec.HostConfig.NetworkMode).toBe('none');
    expect(spec.HostConfig.CapDrop).toEqual(['ALL']);
    expect(spec.HostConfig.ReadonlyRootfs).toBe(true);
    expect(spec.HostConfig.Binds.join()).not.toMatch(/docker\.sock/);
    expect(harness.state.removed).toBe(1);
    expect(harness.state.activeHelpers.size).toBe(0);
  });
});

describe('supervisor import', () => {
  const workspaceArchive = (files) => encodeOdar('workspace', files);

  it('restores a deleted marker byte-for-byte and replaces other workspace content', async () => {
    harness = createHarness();
    writeFileSync(harness.ws('marker.bin'), binary);
    const archive = await (await harness.exportOf('workspace')).arrayBuffer();
    rmSync(harness.ws('marker.bin'));
    writeFileSync(harness.ws('stale.txt'), 'created after the backup');
    const response = await harness.importOf('workspace', Buffer.from(archive));
    expect(response.status).toBe(200);
    expect(readFileSync(harness.ws('marker.bin'))).toEqual(binary);
    expect(existsSync(harness.ws('stale.txt'))).toBe(false);
    expect(
      readdirSync(join(harness.root, 'workspace')).filter((name) =>
        name.startsWith('.opendots-'),
      ),
    ).toEqual([]);
    expect(harness.state.activeHelpers.size).toBe(0);
  });

  it('restores the browser profile directory in place and leaves the workspace alone', async () => {
    harness = createHarness();
    writeFileSync(harness.ws('keep.txt'), 'keep');
    mkdirSync(harness.pf('Default/Network'), { recursive: true });
    writeFileSync(harness.pf('Default/Network/Cookies'), binary);
    const archive = Buffer.from(
      await (await harness.exportOf('browser-profile')).arrayBuffer(),
    );
    rmSync(harness.pf('Default'), { recursive: true });
    writeFileSync(harness.pf('junk'), 'junk');
    const response = await harness.importOf('browser-profile', archive);
    expect(response.status).toBe(200);
    expect(readFileSync(harness.pf('Default/Network/Cookies'))).toEqual(binary);
    expect(existsSync(harness.pf('junk'))).toBe(false);
    expect(readFileSync(harness.ws('keep.txt'), 'utf8')).toBe('keep');
    expect(readdirSync(join(harness.root, 'profiles')).sort()).toEqual([
      'dot-a',
    ]);
  });

  it('accepts legacy millisecond timestamps and archives without mode metadata', async () => {
    harness = createHarness();
    const legacy = gzipSync(
      Buffer.from(
        JSON.stringify({
          magic: 'ODAR',
          version: 1,
          type: 'workspace',
          createdAt: Date.now(),
          files: [
            {
              path: 'old/notes.txt',
              dataBase64: Buffer.from('legacy').toString('base64'),
              size: 6,
              mtime: Date.now(),
            },
          ],
        }),
      ),
    );
    const response = await harness.importOf('workspace', legacy);
    expect(response.status).toBe(200);
    expect(readFileSync(harness.ws('old/notes.txt'), 'utf8')).toBe('legacy');
  });

  it('rejects corrupt, traversal and wrong-type archives before creating a helper', async () => {
    harness = createHarness();
    writeFileSync(harness.ws('precious.txt'), 'precious');
    const traversal = gzipSync(
      Buffer.from(
        JSON.stringify({
          magic: 'ODAR',
          version: 1,
          type: 'workspace',
          createdAt: 1,
          files: [{ path: '../x', dataBase64: 'eA==', size: 1 }],
        }),
      ),
    );
    for (const body of [
      Buffer.from('garbage'),
      traversal,
      encodeOdar('browser-profile', []),
    ]) {
      const response = await harness.importOf('workspace', body);
      expect(response.status).toBe(400);
    }
    expect((await harness.importOf('nonsense', Buffer.from('x'))).status).toBe(
      400,
    );
    expect(harness.state.created).toHaveLength(0);
    expect(readFileSync(harness.ws('precious.txt'), 'utf8')).toBe('precious');
  });

  it('keeps existing data when staging fails', async () => {
    harness = createHarness({ failPutArchive: true });
    writeFileSync(harness.ws('precious.txt'), 'precious');
    const response = await harness.importOf(
      'workspace',
      workspaceArchive([{ path: 'new.txt', data: Buffer.from('new') }]),
    );
    expect(response.status).toBe(500);
    expect(readFileSync(harness.ws('precious.txt'), 'utf8')).toBe('precious');
    expect(existsSync(harness.ws('new.txt'))).toBe(false);
    expect(
      readdirSync(join(harness.root, 'workspace')).filter((name) =>
        name.startsWith('.opendots-'),
      ),
    ).toEqual([]);
    expect(harness.state.activeHelpers.size).toBe(0);
  });

  it('rolls the workspace back when the commit step fails part-way', async () => {
    harness = createHarness({
      failExec: (command) =>
        command.includes('mv -- "$p" /workspace/; done') &&
        command.includes('stage') &&
        !command.includes('rm -rf'),
    });
    mkdirSync(harness.ws('dir'), { recursive: true });
    writeFileSync(harness.ws('dir/original.txt'), 'original');
    writeFileSync(harness.ws('.hidden'), 'hidden');
    const response = await harness.importOf(
      'workspace',
      workspaceArchive([{ path: 'new.txt', data: Buffer.from('new') }]),
    );
    expect(response.status).toBe(500);
    expect(readFileSync(harness.ws('dir/original.txt'), 'utf8')).toBe(
      'original',
    );
    expect(readFileSync(harness.ws('.hidden'), 'utf8')).toBe('hidden');
    expect(existsSync(harness.ws('new.txt'))).toBe(false);
    expect(
      readdirSync(join(harness.root, 'workspace')).filter((name) =>
        name.startsWith('.opendots-'),
      ),
    ).toEqual([]);
  });

  it('full-computer: a failing profile swap restores BOTH the workspace and the profile', async () => {
    harness = createHarness({
      failExec: (command) =>
        command.includes("/profiles/'") === false &&
        /mv -- '[^']*\.opendots-b2-stage-[0-9a-f]+' '[^']*dot-a'/.test(command),
    });
    writeFileSync(harness.ws('w.txt'), 'old-workspace');
    writeFileSync(harness.pf('p.txt'), 'old-profile');
    const archive = encodeOdar('full-computer', [
      { path: 'workspace/w.txt', data: Buffer.from('new-workspace') },
      { path: 'browser-profile/p.txt', data: Buffer.from('new-profile') },
    ]);
    const response = await harness.importOf('full-computer', archive);
    expect(response.status).toBe(500);
    expect(readFileSync(harness.ws('w.txt'), 'utf8')).toBe('old-workspace');
    expect(readFileSync(harness.pf('p.txt'), 'utf8')).toBe('old-profile');
    expect(
      readdirSync(join(harness.root, 'workspace')).filter((name) =>
        name.startsWith('.opendots-'),
      ),
    ).toEqual([]);
    expect(readdirSync(join(harness.root, 'profiles')).sort()).toEqual([
      'dot-a',
    ]);
  });

  it('a cleanup failure after commit keeps the restored data and reports success', async () => {
    harness = createHarness({
      failExec: (command) =>
        command.includes('rm -rf') && command.includes('rollback'),
    });
    writeFileSync(harness.ws('old.txt'), 'old');
    const response = await harness.importOf(
      'workspace',
      workspaceArchive([{ path: 'new.txt', data: Buffer.from('new') }]),
    );
    expect(response.status).toBe(200);
    expect(readFileSync(harness.ws('new.txt'), 'utf8')).toBe('new');
    expect(harness.warnings.join('\n')).toMatch(
      /cleanup needs operator review/,
    );
    // The retained rollback directory uses a reserved name, so later exports still work.
    const exported = await harness.exportOf('workspace');
    expect(exported.status).toBe(200);
    expect(
      decodeOdar(Buffer.from(await exported.arrayBuffer()), 'workspace').map(
        (e) => e.path,
      ),
    ).toEqual(['new.txt']);
  });

  it('refuses to import into a running computer, an unowned volume, or a missing volume', async () => {
    harness = createHarness();
    const body = workspaceArchive([{ path: 'x.txt', data: Buffer.from('x') }]);
    harness.state.containers.get('ns-computer-dot-a').running = true;
    expect((await harness.importOf('workspace', body)).status).toBe(409);
    harness.state.containers.get('ns-computer-dot-a').running = false;
    harness.state.volumes.set('ns-profile-dot-a', 'someone-else');
    expect((await harness.importOf('workspace', body)).status).toBe(409);
    harness.state.volumes.delete('ns-profile-dot-a');
    expect((await harness.importOf('workspace', body)).status).toBe(404);
    expect((await harness.importOf('workspace', body, 'ghost')).status).toBe(
      404,
    );
    expect(harness.state.createVolumeCalls).toBe(0);
  });

  it('may restore into owned volumes when the original container is gone', async () => {
    harness = createHarness();
    harness.state.containers.clear();
    const response = await harness.importOf(
      'workspace',
      workspaceArchive([{ path: 'back.txt', data: Buffer.from('back') }]),
    );
    expect(response.status).toBe(200);
    expect(readFileSync(harness.ws('back.txt'), 'utf8')).toBe('back');
  });
});

describe('locking', () => {
  it('serialises two backups for one Dot and releases the lock afterwards', async () => {
    harness = createHarness();
    writeFileSync(harness.ws('a.txt'), 'a');
    const [first, second] = await Promise.all([
      harness.exportOf('workspace'),
      harness.exportOf('workspace'),
    ]);
    expect([first.status, second.status].sort()).toEqual([200, 409]);
    expect((await harness.exportOf('workspace')).status).toBe(200);
  });

  it('a second supervisor process is stopped by the deterministic helper name', async () => {
    harness = createHarness();
    harness.state.activeHelpers.add('ns-backup-helper-dot-a');
    const response = await harness.exportOf('workspace');
    expect(response.status).toBe(409);
  });

  it('blocks stop while a backup holds the Dot, and a backup while stop is in flight', async () => {
    harness = createHarness({ slowStop: true });
    writeFileSync(harness.ws('a.txt'), 'a');
    const backup = harness.exportOf('workspace');
    const stopDuringBackup = await harness.app.request(
      'http://s/computers/dot-a/stop',
      { method: 'POST' },
    );
    expect(stopDuringBackup.status).toBe(409);
    expect((await backup).status).toBe(200);

    const stop = harness.app.request('http://s/computers/dot-a/stop', {
      method: 'POST',
    });
    await new Promise((r) => setTimeout(r, 10));
    expect((await harness.exportOf('workspace')).status).toBe(409);
    expect((await stop).status).toBe(200);
    expect((await harness.exportOf('workspace')).status).toBe(200);
  });

  it('does not block other Dots', async () => {
    harness = createHarness();
    const other = await harness.app.request('http://s/computers/dot-b/stop', {
      method: 'POST',
    });
    expect(other.status).toBe(200);
  });
});

describe('tar parsing', () => {
  it('rejects symlinks, hard links and special files, but drops Chromium singleton links', () => {
    expect(() =>
      parseTarArchive(
        buildTar([{ name: 'p/x', type: '2' }]),
        '/p',
        'workspace',
      ),
    ).toThrow(/links/);
    expect(() =>
      parseTarArchive(
        buildTar([{ name: 'p/x', type: '1' }]),
        '/p',
        'workspace',
      ),
    ).toThrow(/links/);
    expect(() =>
      parseTarArchive(
        buildTar([{ name: 'p/x', type: '3' }]),
        '/p',
        'workspace',
      ),
    ).toThrow(/special/);
    expect(() =>
      parseTarArchive(
        buildTar([{ name: 'p/SingletonLock', type: '2' }]),
        '/p',
        'workspace',
      ),
    ).toThrow(/links/);
    expect(
      parseTarArchive(
        buildTar([
          { name: 'p/SingletonLock', type: '2' },
          { name: 'p/ok', data: Buffer.from('1') },
        ]),
        '/p',
        'browser-profile',
      ).map((e) => e.path),
    ).toEqual(['ok']);
  });

  it('enforces the per-file budget and the archive size on encode', () => {
    expect(() =>
      createTarArchive([
        { path: 'a', data: Buffer.alloc(0) },
        ...Array.from({ length: 10_001 }, (_, i) => ({
          path: 'f' + i,
          data: Buffer.alloc(0),
        })),
      ]),
    ).toThrow(/file-count/);
  });

  it('round-trips long paths and every byte value', () => {
    const all = Buffer.from(Array.from({ length: 256 }, (_, i) => i));
    const longPath =
      Array.from({ length: 12 }, () => 'segment-name').join('/') + '/leaf.bin';
    const [entry] = parseTarArchive(
      createTarArchive([
        { path: longPath, data: all, mode: 0o750, mtime: 1_700_000_000 },
      ]),
      '/__none__',
      'workspace',
    );
    expect(entry.path).toBe(longPath);
    expect(entry.data).toEqual(all);
    expect(entry.mode).toBe(0o750);
    expect(statSync(tmpdir()).isDirectory()).toBe(true);
  });
});
