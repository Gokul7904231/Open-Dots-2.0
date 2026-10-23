/* global process, console, Buffer */
// Verifies the build-time supervisor patch against the EXACT OpenBot revision pinned in
// compose.computers.yml: the patch applies, the patched source typechecks, middleware
// ordering keeps the backup routes behind authentication, and the patched application
// answers requests correctly without Docker. Needs network access to github.com and npm.
import { execFileSync } from 'node:child_process';
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { gzipSync } from 'node:zlib';

const repo = resolve(import.meta.dirname, '..');
const compose = readFileSync(join(repo, 'compose.computers.yml'), 'utf8');
const sha = /OpenBot\.git#([0-9a-f]{40})/.exec(compose)?.[1];
if (!sha)
  throw new Error(
    'Could not read the pinned OpenBot revision from compose.computers.yml.',
  );

const work = mkdtempSync(join(tmpdir(), 'opendots-supervisor-verify-'));
const results = [];
function pass(message) {
  results.push(message);
  console.log('PASS  ' + message);
}
function fail(message) {
  throw new Error(message);
}
function run(command, args, cwd, extra = {}) {
  return execFileSync(command, args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 50_000_000,
    shell: process.platform === 'win32',
    ...extra,
  });
}

try {
  console.log('Pinned OpenBot revision: ' + sha);
  const source = join(work, 'openbot');
  mkdirSync(source);
  run('git', ['init', '--quiet'], source);
  run(
    'git',
    [
      'fetch',
      '--depth',
      '1',
      '--quiet',
      'https://github.com/CopilotKit/OpenBot.git',
      sha,
    ],
    source,
  );
  run('git', ['checkout', '--quiet', 'FETCH_HEAD'], source);
  const head = run('git', ['rev-parse', 'HEAD'], source).trim();
  if (head !== sha) fail('Fetched revision does not match the pin.');
  pass('Fetched exact pinned revision ' + sha.slice(0, 12));

  const app = join(work, 'app');
  mkdirSync(join(app, 'src'), { recursive: true });
  cpSync(join(source, 'supervisor', 'src'), join(app, 'src'), {
    recursive: true,
  });
  cpSync(join(source, 'tsconfig.base.json'), join(app, 'tsconfig.base.json'));
  cpSync(
    join(source, 'supervisor', 'tsconfig.json'),
    join(app, 'tsconfig.json'),
  );
  const upstream = JSON.parse(
    readFileSync(join(source, 'supervisor', 'package.json'), 'utf8'),
  );
  const dev = upstream.devDependencies;
  writeFileSync(
    join(app, 'package.json'),
    JSON.stringify({
      name: 'verify',
      private: true,
      type: 'module',
      dependencies: upstream.dependencies,
      devDependencies: dev,
    }),
  );
  // tsconfig.base.json is one directory above the supervisor in the real repository.
  writeFileSync(
    join(app, 'tsconfig.json'),
    readFileSync(join(app, 'tsconfig.json'), 'utf8').replace(
      '../tsconfig.base.json',
      './tsconfig.base.json',
    ),
  );

  const { hardenSupervisorEnvironment, hardenSupervisorIndex } = await import(
    pathToFileURL(join(repo, 'deployment/computers/harden-supervisor.mjs')).href
  );
  const envPath = join(app, 'src', 'environment.ts');
  const indexPath = join(app, 'src', 'index.ts');
  writeFileSync(
    envPath,
    hardenSupervisorEnvironment(readFileSync(envPath, 'utf8')),
  );
  writeFileSync(
    indexPath,
    hardenSupervisorIndex(readFileSync(indexPath, 'utf8')),
  );
  for (const name of [
    'b2-archive-format.mjs',
    'b2-archive-core.mjs',
    'b2-archive-supervisor.mjs',
    'b2-archive-supervisor.d.mts',
  ]) {
    cpSync(join(repo, 'deployment/computers', name), join(app, 'src', name));
  }
  pass('Build-time patch applied to the pinned supervisor source');

  const patched = readFileSync(indexPath, 'utf8');
  const order = [
    patched.indexOf('context.req.header("authorization")'),
    patched.indexOf('app.use("*", lifecycleGuard)'),
    patched.indexOf('app.post("/computers/:botId/ensure"'),
    patched.indexOf('attachBackupRoutes(app, resolve)'),
    patched.indexOf('serve({ port'),
  ];
  if (
    order.some((index) => index < 0) ||
    order.some((index, i) => i > 0 && index <= order[i - 1])
  ) {
    fail(
      'Patched middleware/route order is wrong; backup routes could precede authentication.',
    );
  }
  pass(
    'Authentication middleware precedes the lifecycle guard and the backup routes',
  );

  run('npm', ['install', '--no-audit', '--no-fund', '--ignore-scripts'], app);
  run(
    'npm',
    [
      'install',
      '--no-audit',
      '--no-fund',
      '--ignore-scripts',
      '--no-save',
      'tsx@^4',
      '@types/bun',
    ],
    app,
  );
  run('npx', ['tsc', '--noEmit', '-p', '.'], app);
  pass('Patched supervisor source typechecks (tsc --noEmit, strict)');

  // Run the actual patched application with a stand-in for Bun.serve, which captures
  // the fetch handler so real requests can be answered without a listener or Docker.
  const stub = join(app, 'node_modules', 'bun');
  mkdirSync(stub, { recursive: true });
  writeFileSync(
    join(stub, 'package.json'),
    '{"name":"bun","type":"module","main":"index.js"}',
  );
  writeFileSync(
    join(stub, 'index.js'),
    'export function serve(options) { globalThis.__serveOptions = options; globalThis.__fetch = options.fetch; }\n',
  );
  const token = 'verify-supervisor-token-not-a-secret';
  const odar = (type, files) =>
    gzipSync(
      Buffer.from(
        JSON.stringify({
          magic: 'ODAR',
          version: 1,
          type,
          createdAt: Date.now(),
          files,
        }),
      ),
    );
  const traversal = odar('workspace', [
    {
      path: '../escape.txt',
      dataBase64: Buffer.from('x').toString('base64'),
      size: 1,
      mtime: 1,
      mode: 420,
    },
  ]).toString('base64');
  const wrongType = odar('workspace', []).toString('base64');
  writeFileSync(
    join(app, 'probe.mjs'),
    `await import('./src/index.ts');
const T = ${JSON.stringify(token)};
const auth = { Authorization: 'Bearer ' + T };
const call = async (method, path, headers = {}, body) => {
  const response = await globalThis.__fetch(new Request('http://supervisor' + path, { method, headers, body }));
  return response.status;
};
const out = {
  options: globalThis.__serveOptions && { idleTimeout: globalThis.__serveOptions.idleTimeout, maxRequestBodySize: globalThis.__serveOptions.maxRequestBodySize },
  health: await call('GET', '/health'),
  exportNoToken: await call('GET', '/computers/dot1/export?type=workspace'),
  exportWrongToken: await call('GET', '/computers/dot1/export?type=workspace', { Authorization: 'Bearer wrong' }),
  importNoToken: await call('POST', '/computers/dot1/import?type=workspace', {}, 'x'),
  importWrongToken: await call('POST', '/computers/dot1/import?type=workspace', { Authorization: 'Bearer wrong' }, 'x'),
  lifecycleNoToken: await call('POST', '/computers/dot1/stop'),
  invalidDot: await call('GET', '/computers/bad.id/export?type=workspace', auth),
  invalidDotImport: await call('POST', '/computers/bad.id/import?type=workspace', auth, 'x'),
  missingType: await call('GET', '/computers/dot1/export', auth),
  invalidType: await call('GET', '/computers/dot1/export?type=everything', auth),
  garbageImport: await call('POST', '/computers/dot1/import?type=workspace', auth, 'not an archive'),
  traversalImport: await call('POST', '/computers/dot1/import?type=workspace', auth, Buffer.from(${JSON.stringify(traversal)}, 'base64')),
  wrongTypeImport: await call('POST', '/computers/dot1/import?type=browser-profile', auth, Buffer.from(${JSON.stringify(wrongType)}, 'base64')),
  noDocker: await call('GET', '/computers/dot1/export?type=workspace', auth),
};
console.log('PROBE ' + JSON.stringify(out));
process.exit(0);
`,
  );
  const socket =
    process.platform === 'win32'
      ? '\\\\.\\pipe\\opendots-verify-missing'
      : '/nonexistent/opendots-verify.sock';
  const probe = run('node', ['--import', 'tsx', 'probe.mjs'], app, {
    env: {
      ...process.env,
      PORT: '4300',
      SUPERVISOR_TOKEN: token,
      COMPUTER_TOKEN: 'verify-computer-token-at-least-24-chars',
      COMPUTER_NAMESPACE: 'verify',
      DOCKER_SOCKET: socket,
    },
  });
  const line = probe.split('\n').find((entry) => entry.startsWith('PROBE '));
  if (!line) fail('The patched supervisor did not answer probe requests.');
  const r = JSON.parse(line.slice('PROBE '.length));
  const expect = (name, actual, wanted) => {
    if (actual !== wanted)
      fail(name + ': expected HTTP ' + wanted + ', got ' + actual);
  };
  expect('health stays open', r.health, 200);
  expect('export without token', r.exportNoToken, 401);
  expect('export with wrong token', r.exportWrongToken, 401);
  expect('import without token', r.importNoToken, 401);
  expect('import with wrong token', r.importWrongToken, 401);
  expect('lifecycle without token', r.lifecycleNoToken, 401);
  pass(
    'Export/import (and lifecycle) routes reject missing or wrong supervisor tokens; /health stays open',
  );
  expect('invalid Dot id export', r.invalidDot, 400);
  expect('invalid Dot id import', r.invalidDotImport, 400);
  expect('missing type', r.missingType, 400);
  expect('invalid type', r.invalidType, 400);
  pass(
    'Invalid Dot identifiers and backup types are rejected before any Docker call',
  );
  expect('garbage archive', r.garbageImport, 400);
  expect('path traversal archive', r.traversalImport, 400);
  expect('wrong-type archive', r.wrongTypeImport, 400);
  pass(
    'Garbage, path-traversal and wrong-type archives are rejected with 400 before touching storage',
  );
  expect('Docker unreachable', r.noDocker, 503);
  pass('An unreachable Docker daemon yields 503 without leaking details');
  if (
    r.options?.maxRequestBodySize !== 600 * 1024 * 1024 ||
    r.options?.idleTimeout !== 255
  ) {
    fail('Patched Bun.serve options are wrong: ' + JSON.stringify(r.options));
  }
  pass(
    'Bun.serve accepts uploads up to the 600 MiB archive limit with a 255 s idle timeout',
  );
  console.log(
    'PINNED SUPERVISOR PATCH VERIFICATION RESULT: PASS (' +
      results.length +
      ' checks)',
  );
} catch (error) {
  const detail = error instanceof Error ? error.message : String(error);
  console.error(
    'PINNED SUPERVISOR PATCH VERIFICATION RESULT: FAIL - ' +
      detail.split('\n').slice(0, 12).join(' | '),
  );
  console.log(
    '::error title=Pinned supervisor patch verification::' +
      detail.replace(/\r?\n/g, ' | ').slice(0, 900),
  );
  process.exitCode = 1;
} finally {
  rmSync(work, { recursive: true, force: true });
}
