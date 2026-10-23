/* global process, URL, fetch, AbortSignal, AbortController, console, Buffer, setTimeout */
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { decodeOdar } from '../deployment/computers/b2-archive-format.mjs';

const baseUrl = new URL(
  process.env.OPENDOTS_BASE_URL ?? 'http://127.0.0.1:4310',
);
const supervisorUrl = new URL(
  process.env.COMPUTER_SUPERVISOR_URL ?? 'http://127.0.0.1:4312',
);
const ownerToken = process.env.OWNER_TOKEN?.trim();
const supervisorToken = process.env.COMPUTER_SUPERVISOR_TOKEN?.trim();
const namespace = process.env.COMPUTER_NAMESPACE?.trim() || 'opendots';
const computerImage =
  process.env.COMPUTER_IMAGE?.trim() || 'opendots-computer:b6932d3';
const requestedDotId = process.env.DOT_ID?.trim();
const timeoutMs = Number.parseInt(
  process.env.COMPUTER_QUALIFY_TIMEOUT_MS ?? '90000',
  10,
);
const allowRestart = process.env.COMPUTER_QUALIFY_ALLOW_RESTART === '1';

if (!ownerToken || !supervisorToken) {
  console.error(
    'OWNER_TOKEN and COMPUTER_SUPERVISOR_TOKEN must be configured without printing their values.',
  );
  process.exit(1);
}
for (const [label, url] of [
  ['OPENDOTS_BASE_URL', baseUrl],
  ['COMPUTER_SUPERVISOR_URL', supervisorUrl],
]) {
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.pathname !== '/'
  ) {
    console.error(
      label +
        ' must be an HTTP(S) origin without embedded credentials or a path.',
    );
    process.exit(1);
  }
}
if (
  !/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(namespace) ||
  !Number.isSafeInteger(timeoutMs) ||
  timeoutMs < 1000 ||
  timeoutMs > 300000
) {
  console.error('Invalid COMPUTER_NAMESPACE or COMPUTER_QUALIFY_TIMEOUT_MS.');
  process.exit(1);
}

function fail(message) {
  throw new Error(message);
}

function logPass(message) {
  console.log('PASS  ' + message);
}

function quoteShell(value) {
  return "'" + String(value).replace(/'/g, "'\\''") + "'";
}

async function api(path, method = 'GET', body) {
  const response = await fetch(new URL('/api' + path, baseUrl.origin), {
    method,
    redirect: 'error',
    signal: AbortSignal.timeout(timeoutMs),
    headers: {
      Authorization: 'Bearer ' + ownerToken,
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const raw = await response.text();
  if (raw.length > 4_000_000) fail('OpenDots API response exceeded 4 MB.');
  let result;
  try {
    result = JSON.parse(raw);
  } catch {
    fail(
      'OpenDots API returned non-JSON content (HTTP ' + response.status + ').',
    );
  }
  if (!response.ok) {
    const detail =
      typeof result?.error === 'string'
        ? ': ' + result.error.slice(0, 200)
        : '';
    fail('OpenDots API returned HTTP ' + response.status + detail);
  }
  return result;
}

async function supervisorExport(dotId, type) {
  const response = await fetch(
    new URL(
      '/computers/' +
        encodeURIComponent(dotId) +
        '/export?type=' +
        encodeURIComponent(type),
      supervisorUrl.origin,
    ),
    {
      method: 'GET',
      redirect: 'error',
      signal: AbortSignal.timeout(timeoutMs),
      headers: { Authorization: 'Bearer ' + supervisorToken },
    },
  );
  if (!response.ok) {
    const detail = (await response.text()).slice(0, 200);
    fail(
      'Supervisor export returned HTTP ' +
        response.status +
        (detail ? ': ' + detail : ''),
    );
  }
  const declared = Number(response.headers.get('content-length') ?? '');
  const max = 600 * 1024 * 1024;
  if (Number.isFinite(declared) && declared > max)
    fail('Supervisor export exceeded 600 MiB.');
  if (!response.body) fail('Supervisor export returned an empty body.');
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    for (;;) {
      const item = await reader.read();
      if (item.done) break;
      total += item.value.length;
      if (total > max) {
        await reader.cancel();
        fail('Supervisor export exceeded 600 MiB.');
      }
      chunks.push(Buffer.from(item.value));
    }
  } finally {
    reader.releaseLock();
  }
  const archive = Buffer.concat(chunks);
  decodeOdar(archive, type);
  return archive;
}

async function supervisorImport(dotId, type, archive) {
  const response = await fetch(
    new URL(
      '/computers/' +
        encodeURIComponent(dotId) +
        '/import?type=' +
        encodeURIComponent(type),
      supervisorUrl.origin,
    ),
    {
      method: 'POST',
      redirect: 'error',
      signal: AbortSignal.timeout(timeoutMs),
      headers: {
        Authorization: 'Bearer ' + supervisorToken,
        'Content-Type': 'application/octet-stream',
      },
      body: new Uint8Array(archive),
    },
  );
  const raw = await response.text();
  let result = {};
  try {
    result = raw ? JSON.parse(raw) : {};
  } catch {
    fail(
      'Supervisor import returned non-JSON content (HTTP ' +
        response.status +
        ').',
    );
  }
  if (!response.ok || result.imported !== true) {
    const detail =
      typeof result?.error === 'string'
        ? ': ' + result.error.slice(0, 200)
        : '';
    fail('Supervisor import returned HTTP ' + response.status + detail);
  }
}

async function action(dotId, name, input) {
  return api(
    '/dots/' + encodeURIComponent(dotId) + '/computer/actions',
    'POST',
    {
      action: name,
      input,
    },
  );
}

function runVolumeCommand(volumeName, mountPoint, command) {
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,254}$/.test(volumeName)) {
    fail('Refusing invalid Docker volume name.');
  }
  if (!['/workspace', '/profiles'].includes(mountPoint)) {
    fail('Refusing unexpected Docker volume mount point.');
  }
  return execFileSync(
    'docker',
    [
      'run',
      '--rm',
      '--network',
      'none',
      '--volume',
      volumeName + ':' + mountPoint,
      '--entrypoint',
      'sh',
      computerImage,
      '-c',
      command,
    ],
    {
      encoding: 'utf8',
      stdio: 'pipe',
      timeout: timeoutMs,
      maxBuffer: 1_000_000,
    },
  );
}

function sha256InVolume(volumeName, mountPoint, path) {
  const out = runVolumeCommand(
    volumeName,
    mountPoint,
    'sha256sum ' + quoteShell(path),
  );
  return out.trim().split(/\s+/)[0];
}

function helperContainersLeft() {
  return execFileSync(
    'docker',
    [
      'ps',
      '-a',
      '--filter',
      'label=opendots.backup.helper=true',
      '--format',
      '{{.Names}}',
    ],
    { encoding: 'utf8', stdio: 'pipe', timeout: timeoutMs },
  ).trim();
}

function volumeExists(name) {
  try {
    execFileSync('docker', ['volume', 'inspect', name], {
      stdio: 'pipe',
      timeout: timeoutMs,
    });
    return true;
  } catch {
    return false;
  }
}

async function rawSupervisor(method, path, { token, body } = {}) {
  const response = await fetch(new URL(path, supervisorUrl.origin), {
    method,
    redirect: 'error',
    signal: AbortSignal.timeout(timeoutMs),
    headers: {
      ...(token === undefined ? {} : { Authorization: 'Bearer ' + token }),
      ...(body === undefined
        ? {}
        : { 'Content-Type': 'application/octet-stream' }),
    },
    ...(body === undefined ? {} : { body: new Uint8Array(body) }),
  });
  await response.arrayBuffer();
  return response.status;
}

function expectStatus(label, actual, wanted) {
  if (!wanted.includes(actual))
    fail(label + ': expected HTTP ' + wanted.join(' or ') + ', got ' + actual);
}

function markerPath() {
  return (
    'opendots-supervisor-backup-marker-' +
    randomUUID().replaceAll('-', '') +
    '.txt'
  );
}

function assertEntry(archive, type, path, expectedContents) {
  const entries = decodeOdar(archive, type);
  const entry = entries.find((candidate) => candidate.path === path);
  if (!entry) fail('Archive did not include expected path: ' + path);
  if (entry.data.toString('utf8') !== expectedContents) {
    fail('Archive marker contents did not match for: ' + path);
  }
  return entries;
}

async function main() {
  if (!requestedDotId && process.env.CI !== 'true') {
    fail(
      'Set DOT_ID to a disposable test Dot before running this script outside CI.',
    );
  }

  const workspace = await api('/workspace');
  if (!Array.isArray(workspace.dots) || workspace.dots.length === 0)
    fail('No Dots exist in the OpenDots workspace.');
  const dot = requestedDotId
    ? workspace.dots.find((item) => item.id === requestedDotId)
    : workspace.dots[0];
  if (!dot) fail('DOT_ID does not match a Dot in the OpenDots workspace.');
  const dotId = dot.id;
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(dotId))
    fail('Selected Dot ID is not valid for supervisor naming.');

  const originalStatus = await api(
    '/dots/' + encodeURIComponent(dotId) + '/computer',
  );
  const originalPermissions = originalStatus.permissions;
  if (
    !originalStatus.configured ||
    originalStatus.state === 'unavailable' ||
    originalStatus.state === 'not_configured'
  ) {
    fail(
      'The selected Dot computer is not configured or the provider is unavailable.',
    );
  }
  if (originalStatus.state === 'running' && !allowRestart) {
    fail(
      'Selected computer is already running. Set COMPUTER_QUALIFY_ALLOW_RESTART=1 only for a disposable test Dot.',
    );
  }

  const workspaceVolume = namespace + '-workspace-' + dotId;
  const profileVolume = namespace + '-profile-' + dotId;
  const workspaceFile = markerPath();
  const binaryFile = markerPath().replace('.txt', '.bin');
  const profileFile = markerPath();
  const workspaceMarker = 'workspace-archive-proof-' + randomUUID();
  const profileMarker = 'profile-archive-proof-' + randomUUID();
  const cookieName = 'odsb_' + randomUUID().replaceAll('-', '').slice(0, 16);
  const cookieValue = randomUUID().replaceAll('-', '');
  const cookie =
    cookieName +
    '=' +
    cookieValue +
    '; Path=/; Max-Age=3600; Secure; SameSite=Lax';

  let permissionsChanged = false;

  try {
    await api(
      '/dots/' + encodeURIComponent(dotId) + '/computer/permissions',
      'PATCH',
      {
        enabled: true,
        browser: true,
        files: true,
        shell: false,
      },
    );
    permissionsChanged = true;

    await api(
      '/dots/' + encodeURIComponent(dotId) + '/computer/start',
      'POST',
      {},
    );
    // -------- Workspace archive round trip through the actual Docker supervisor --------
    await action(dotId, 'files_write', {
      path: workspaceFile,
      contents: workspaceMarker,
    });
    const check = await action(dotId, 'files_read', { path: workspaceFile });
    if (check.text !== workspaceMarker)
      fail('Workspace marker was not readable before export.');

    await api(
      '/dots/' + encodeURIComponent(dotId) + '/computer/stop',
      'POST',
      {},
    );
    // The computer API only carries text. A binary marker (every awkward byte value)
    // is written straight into the stopped volume and tracked by SHA-256.
    runVolumeCommand(
      workspaceVolume,
      '/workspace',
      "printf '\\000\\001\\002\\012\\015\\177\\200\\376\\377' > " +
        quoteShell('/workspace/' + binaryFile) +
        ' && chmod 755 ' +
        quoteShell('/workspace/' + binaryFile),
    );
    const binarySha = sha256InVolume(
      workspaceVolume,
      '/workspace',
      '/workspace/' + binaryFile,
    );
    const workspaceArchive = await supervisorExport(dotId, 'workspace');
    assertEntry(workspaceArchive, 'workspace', workspaceFile, workspaceMarker);
    const exportedBinary = decodeOdar(workspaceArchive, 'workspace').find(
      (entry) => entry.path === binaryFile,
    );
    if (
      !exportedBinary ||
      createHash('sha256').update(exportedBinary.data).digest('hex') !==
        binarySha
    ) {
      fail('Exported binary marker did not match its SHA-256 in the volume.');
    }
    if ((exportedBinary.mode & 0o111) === 0)
      fail('Executable bit was not preserved in the export.');
    logPass(
      'Real supervisor workspace export contains the text and binary markers with the executable bit.',
    );

    runVolumeCommand(
      workspaceVolume,
      '/workspace',
      'rm -f -- ' +
        quoteShell('/workspace/' + workspaceFile) +
        ' ' +
        quoteShell('/workspace/' + binaryFile) +
        ' && test ! -e ' +
        quoteShell('/workspace/' + workspaceFile) +
        ' && test ! -e ' +
        quoteShell('/workspace/' + binaryFile),
    );
    await supervisorImport(dotId, 'workspace', workspaceArchive);
    logPass(
      'Real supervisor accepted and imported the verified workspace archive.',
    );
    if (
      sha256InVolume(
        workspaceVolume,
        '/workspace',
        '/workspace/' + binaryFile,
      ) !== binarySha
    ) {
      fail('Binary marker did not recover byte-for-byte (SHA-256 mismatch).');
    }
    runVolumeCommand(
      workspaceVolume,
      '/workspace',
      'test -x ' + quoteShell('/workspace/' + binaryFile),
    );
    logPass(
      'Binary marker recovered byte-for-byte (SHA-256) with its executable bit.',
    );

    await api(
      '/dots/' + encodeURIComponent(dotId) + '/computer/start',
      'POST',
      {},
    );
    const restoredWorkspace = await action(dotId, 'files_read', {
      path: workspaceFile,
    });
    if (restoredWorkspace.text !== workspaceMarker)
      fail(
        'Workspace marker did not recover byte-for-byte after supervisor import.',
      );
    logPass(
      'Workspace marker recovered exactly after delete → export → import → read through the real computer.',
    );

    // Starting a computer invalidates browser refs. Refresh before the next browser
    // action so the gateway never retries against stale refs.
    await action(dotId, 'snapshot', {});
    logPass('Refreshed browser snapshot after workspace restore.');

    // -------- Browser-profile archive round trip through the actual volume --------
    const cookieSetter = new URL('https://httpbin.org/response-headers');
    cookieSetter.searchParams.set('Set-Cookie', cookie);
    const cookieSetup = await action(dotId, 'navigate', {
      url: cookieSetter.toString(),
    });
    if (
      typeof cookieSetup.url !== 'string' ||
      !cookieSetup.url.startsWith('https://httpbin.org/')
    ) {
      fail('Could not reach the HTTPS cookie setup endpoint.');
    }
    const cookieBefore = await action(dotId, 'navigate', {
      url: 'https://httpbin.org/cookies',
    });
    if (
      typeof cookieBefore.text !== 'string' ||
      !cookieBefore.text.includes(cookieName) ||
      !cookieBefore.text.includes(cookieValue)
    ) {
      fail('The controlled cookie was not present before profile export.');
    }

    await api(
      '/dots/' + encodeURIComponent(dotId) + '/computer/stop',
      'POST',
      {},
    );
    runVolumeCommand(
      profileVolume,
      '/profiles',
      'mkdir -p ' +
        quoteShell('/profiles/' + dotId + '/opendots-supervisor-backup') +
        ' && printf %s ' +
        quoteShell(profileMarker) +
        ' > ' +
        quoteShell('/profiles/' + dotId + '/' + profileFile),
    );
    const profileArchive = await supervisorExport(dotId, 'browser-profile');
    const profileEntries = assertEntry(
      profileArchive,
      'browser-profile',
      profileFile,
      profileMarker,
    );
    // Chromium 96+ keeps the cookie database under Default/Network.
    if (
      !profileEntries.some(
        (entry) =>
          entry.path === 'Default/Network/Cookies' ||
          entry.path === 'Default/Cookies',
      )
    ) {
      fail(
        'Browser-profile archive did not include the Chromium cookie database.',
      );
    }
    logPass(
      'Real supervisor browser-profile export contains the marker and Chromium cookie database.',
    );

    runVolumeCommand(
      profileVolume,
      '/profiles',
      'rm -f -- ' +
        quoteShell('/profiles/' + dotId + '/' + profileFile) +
        ' && test ! -e ' +
        quoteShell('/profiles/' + dotId + '/' + profileFile),
    );
    await supervisorImport(dotId, 'browser-profile', profileArchive);
    runVolumeCommand(
      profileVolume,
      '/profiles',
      'test -f ' +
        quoteShell('/profiles/' + dotId + '/' + profileFile) +
        ' && test "$(cat ' +
        quoteShell('/profiles/' + dotId + '/' + profileFile) +
        ')" = ' +
        quoteShell(profileMarker),
    );
    logPass(
      'Browser-profile marker recovered exactly after delete → export → import.',
    );

    await api(
      '/dots/' + encodeURIComponent(dotId) + '/computer/start',
      'POST',
      {},
    );
    await action(dotId, 'snapshot', {});
    logPass('Refreshed browser snapshot after profile restore.');
    const cookieAfter = await action(dotId, 'navigate', {
      url: 'https://httpbin.org/cookies',
    });
    if (
      typeof cookieAfter.text !== 'string' ||
      !cookieAfter.text.includes(cookieName) ||
      !cookieAfter.text.includes(cookieValue)
    ) {
      fail(
        'The browser cookie did not survive the real profile export/import.',
      );
    }
    logPass(
      'The real Chromium cookie survived supervisor browser-profile export/import.',
    );

    await api(
      '/dots/' + encodeURIComponent(dotId) + '/computer/stop',
      'POST',
      {},
    );
    await securityChecks({
      dotId,
      workspaceVolume,
      workspaceFile,
      workspaceArchive,
      otherDotIds: workspace.dots
        .map((item) => item.id)
        .filter((id) => id !== dotId),
    });
    console.log('SUPERVISOR ARCHIVE QUALIFICATION RESULT: PASS');
  } finally {
    // Never leave a production user's computer stopped or permissions changed.
    try {
      const status = await api(
        '/dots/' + encodeURIComponent(dotId) + '/computer',
      );
      if (status.state === 'running' && cookieName) {
        // Do not attempt cookie cleanup with browser refs left stale by a restart.
        await action(dotId, 'snapshot', {});
        const expireCookie = new URL('https://httpbin.org/response-headers');
        expireCookie.searchParams.set(
          'Set-Cookie',
          cookieName + '=; Path=/; Max-Age=0; Secure; SameSite=Lax',
        );
        await action(dotId, 'navigate', { url: expireCookie.toString() });
      }
    } catch {
      console.error(
        'CLEANUP WARNING: could not expire the temporary browser test cookie.',
      );
    }
    try {
      const status = await api(
        '/dots/' + encodeURIComponent(dotId) + '/computer',
      );
      if (status.state === 'running')
        await api(
          '/dots/' + encodeURIComponent(dotId) + '/computer/stop',
          'POST',
          {},
        );
    } catch {
      console.error(
        'CLEANUP WARNING: could not stop the computer before removing test markers.',
      );
    }

    for (const [volume, mount, path] of [
      [workspaceVolume, '/workspace', '/workspace/' + workspaceFile],
      [workspaceVolume, '/workspace', '/workspace/' + binaryFile],
      [profileVolume, '/profiles', '/profiles/' + dotId + '/' + profileFile],
    ]) {
      try {
        runVolumeCommand(volume, mount, 'rm -f -- ' + quoteShell(path));
      } catch {
        console.error(
          'CLEANUP WARNING: a temporary supervisor archive marker may remain in a test volume.',
        );
      }
    }

    try {
      if (originalStatus.state === 'running') {
        await api(
          '/dots/' + encodeURIComponent(dotId) + '/computer/start',
          'POST',
          {},
        );
      } else {
        const status = await api(
          '/dots/' + encodeURIComponent(dotId) + '/computer',
        );
        if (status.state === 'running')
          await api(
            '/dots/' + encodeURIComponent(dotId) + '/computer/stop',
            'POST',
            {},
          );
      }
    } catch {
      console.error(
        'CLEANUP WARNING: could not restore the computer running/stopped state.',
      );
    }
    if (permissionsChanged) {
      try {
        await api(
          '/dots/' + encodeURIComponent(dotId) + '/computer/permissions',
          'PATCH',
          originalPermissions,
        );
      } catch {
        console.error(
          'CLEANUP WARNING: could not restore the original computer permissions.',
        );
      }
    }
  }
}

async function securityChecks({
  dotId,
  workspaceVolume,
  workspaceFile,
  workspaceArchive,
  otherDotIds,
}) {
  const odarJson = (document) =>
    gzipSync(Buffer.from(JSON.stringify(document)));
  const marker = () =>
    sha256InVolume(
      workspaceVolume,
      '/workspace',
      '/workspace/' + workspaceFile,
    );
  const markerBefore = marker();
  const exportPath = (id, type) =>
    '/computers/' +
    id +
    '/export' +
    (type === undefined ? '' : '?type=' + type);
  const importPath = (id, type) =>
    '/computers/' +
    id +
    '/import' +
    (type === undefined ? '' : '?type=' + type);
  const good = supervisorToken;

  // Authentication: the management token guards both routes.
  expectStatus('health is open', await rawSupervisor('GET', '/health'), [200]);
  expectStatus(
    'export without token',
    await rawSupervisor('GET', exportPath(dotId, 'workspace')),
    [401],
  );
  expectStatus(
    'export wrong token',
    await rawSupervisor('GET', exportPath(dotId, 'workspace'), {
      token: 'wrong-token',
    }),
    [401],
  );
  expectStatus(
    'import without token',
    await rawSupervisor('POST', importPath(dotId, 'workspace'), {
      body: workspaceArchive,
    }),
    [401],
  );
  expectStatus(
    'import wrong token',
    await rawSupervisor('POST', importPath(dotId, 'workspace'), {
      token: 'wrong-token',
      body: workspaceArchive,
    }),
    [401],
  );
  logPass(
    'SECURITY Missing or incorrect supervisor token is rejected on export and import (live supervisor).',
  );

  // Identity and type validation happen before any Docker access.
  expectStatus(
    'invalid Dot id',
    await rawSupervisor('GET', exportPath('bad.id', 'workspace'), {
      token: good,
    }),
    [400],
  );
  expectStatus(
    'traversal Dot id',
    await rawSupervisor('GET', '/computers/..%2Fetc/export?type=workspace', {
      token: good,
    }),
    [400, 404],
  );
  expectStatus(
    'invalid type',
    await rawSupervisor('GET', exportPath(dotId, 'everything'), {
      token: good,
    }),
    [400],
  );
  expectStatus(
    'missing type',
    await rawSupervisor('GET', exportPath(dotId), { token: good }),
    [400],
  );
  logPass(
    'SECURITY Invalid Dot identifiers and backup types are rejected (live supervisor).',
  );

  // A Dot with no computer can neither be read nor written, and nothing is created for it.
  const ghost = 'odsb-ghost-' + randomUUID().replaceAll('-', '').slice(0, 12);
  expectStatus(
    'ghost export',
    await rawSupervisor('GET', exportPath(ghost, 'workspace'), { token: good }),
    [404],
  );
  expectStatus(
    'ghost import',
    await rawSupervisor('POST', importPath(ghost, 'workspace'), {
      token: good,
      body: workspaceArchive,
    }),
    [404],
  );
  if (
    volumeExists(namespace + '-workspace-' + ghost) ||
    volumeExists(namespace + '-profile-' + ghost)
  ) {
    fail('A backup request created storage for a Dot with no computer.');
  }
  logPass('SECURITY Unknown Dot is refused and no volume is created for it.');

  // Another Dot can never see this Dot\'s data through its own identifier.
  for (const other of otherDotIds.slice(0, 1)) {
    const response = await fetch(
      new URL(exportPath(other, 'workspace'), supervisorUrl.origin),
      {
        headers: { Authorization: 'Bearer ' + good },
        signal: AbortSignal.timeout(timeoutMs),
      },
    );
    if (response.status === 200) {
      const entries = decodeOdar(
        Buffer.from(await response.arrayBuffer()),
        'workspace',
      );
      if (entries.some((entry) => entry.path === workspaceFile))
        fail("Another Dot's export contained this Dot's marker.");
      logPass(
        "SECURITY Cross-Dot: another Dot's export does not contain this Dot's marker.",
      );
    } else {
      await response.arrayBuffer();
      expectStatus('cross-Dot export', response.status, [404, 409]);
      logPass(
        'SECURITY Cross-Dot: another Dot with no stopped computer is refused.',
      );
    }
  }

  // Corrupt, hostile and wrong-type archives are rejected and change nothing.
  const hostile = [
    ['garbage bytes', Buffer.from('this is not an archive')],
    [
      'path traversal',
      odarJson({
        magic: 'ODAR',
        version: 1,
        type: 'workspace',
        createdAt: 1,
        files: [
          {
            path: '../escape.txt',
            dataBase64: Buffer.from('x').toString('base64'),
            size: 1,
          },
        ],
      }),
    ],
    [
      'absolute path',
      odarJson({
        magic: 'ODAR',
        version: 1,
        type: 'workspace',
        createdAt: 1,
        files: [
          {
            path: '/etc/cron.d/x',
            dataBase64: Buffer.from('x').toString('base64'),
            size: 1,
          },
        ],
      }),
    ],
    [
      'wrong declared type',
      odarJson({
        magic: 'ODAR',
        version: 1,
        type: 'browser-profile',
        createdAt: 1,
        files: [],
      }),
    ],
    [
      'size mismatch',
      odarJson({
        magic: 'ODAR',
        version: 1,
        type: 'workspace',
        createdAt: 1,
        files: [
          {
            path: 'a.txt',
            dataBase64: Buffer.from('x').toString('base64'),
            size: 999,
          },
        ],
      }),
    ],
    [
      'truncated gzip',
      workspaceArchive.subarray(
        0,
        Math.max(10, Math.floor(workspaceArchive.length / 2)),
      ),
    ],
  ];
  for (const [label, body] of hostile) {
    expectStatus(
      'hostile archive (' + label + ')',
      await rawSupervisor('POST', importPath(dotId, 'workspace'), {
        token: good,
        body,
      }),
      [400],
    );
  }
  if (marker() !== markerBefore)
    fail('A rejected archive altered the workspace.');
  logPass(
    'SECURITY Corrupt, traversal, absolute-path, size-mismatch, truncated and wrong-type archives are rejected; workspace unchanged.',
  );

  // A client that disconnects mid-upload leaves nothing behind and does not wedge the lock.
  const abort = new AbortController();
  const partial = Buffer.concat([
    gzipSync(Buffer.from('x')).subarray(0, 10),
    Buffer.alloc(20 * 1024 * 1024, 7),
  ]);
  const interrupted = fetch(
    new URL(importPath(dotId, 'workspace'), supervisorUrl.origin),
    {
      method: 'POST',
      headers: {
        Authorization: 'Bearer ' + good,
        'Content-Type': 'application/octet-stream',
      },
      body: new Uint8Array(partial),
      signal: abort.signal,
    },
  ).catch(() => undefined);
  setTimeout(() => abort.abort(), 30);
  await interrupted;
  const afterAbort = await rawSupervisor(
    'GET',
    exportPath(dotId, 'workspace'),
    { token: good },
  );
  expectStatus('export after interrupted upload', afterAbort, [200, 409]);
  if (marker() !== markerBefore)
    fail('An interrupted upload altered the workspace.');
  logPass(
    'SECURITY Interrupted upload leaves the workspace unchanged and the supervisor responsive.',
  );

  // Concurrency: exports and imports for one Dot serialise; nothing returns a server error.
  const concurrent = await Promise.all([
    rawSupervisor('GET', exportPath(dotId, 'workspace'), { token: good }),
    rawSupervisor('GET', exportPath(dotId, 'workspace'), { token: good }),
    rawSupervisor('POST', importPath(dotId, 'workspace'), {
      token: good,
      body: workspaceArchive,
    }),
    rawSupervisor('POST', importPath(dotId, 'workspace'), {
      token: good,
      body: workspaceArchive,
    }),
  ]);
  for (const status of concurrent)
    expectStatus('concurrent backup request', status, [200, 409]);
  if (!concurrent.includes(200))
    fail('No concurrent backup request succeeded.');
  const settled = await rawSupervisor('GET', exportPath(dotId, 'workspace'), {
    token: good,
  });
  expectStatus('export after concurrent requests', settled, [200]);
  if (marker() !== markerBefore)
    fail('Concurrent backup requests corrupted the workspace.');
  logPass(
    'SECURITY Concurrent export/import requests serialise (200/409 only) and the workspace is intact.',
  );

  // A running computer is never exported from or imported into.
  await api(
    '/dots/' + encodeURIComponent(dotId) + '/computer/start',
    'POST',
    {},
  );
  expectStatus(
    'export while running',
    await rawSupervisor('GET', exportPath(dotId, 'workspace'), { token: good }),
    [409],
  );
  expectStatus(
    'import while running',
    await rawSupervisor('POST', importPath(dotId, 'workspace'), {
      token: good,
      body: workspaceArchive,
    }),
    [409],
  );
  await api(
    '/dots/' + encodeURIComponent(dotId) + '/computer/stop',
    'POST',
    {},
  );
  if (marker() !== markerBefore)
    fail('A refused import altered the workspace.');
  logPass('SECURITY Running computer: export and import are refused with 409.');

  // The helper containers used above are all gone, including after failures.
  const leftovers = helperContainersLeft();
  if (leftovers)
    fail(
      'Temporary backup helper containers were left behind: ' +
        leftovers.split('\n').length,
    );
  logPass('SECURITY No temporary backup helper container remains.');
}

main().catch((error) => {
  const detail = error instanceof Error ? error.message : 'unknown error';
  console.error('SUPERVISOR ARCHIVE QUALIFICATION RESULT: FAIL — ' + detail);
  // A workflow annotation, so the failing step is visible without opening raw logs.
  console.log(
    '::error title=Supervisor archive qualification::' +
      detail.replace(/\r?\n/g, ' ').slice(0, 900),
  );
  process.exit(1);
});
