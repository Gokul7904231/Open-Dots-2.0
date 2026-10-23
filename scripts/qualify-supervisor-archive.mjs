/* global process, URL, fetch, AbortSignal, console */
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { decodeOdar } from '../deployment/computers/b2-archive-format.mjs';

const baseUrl = new URL(process.env.OPENDOTS_BASE_URL ?? 'http://127.0.0.1:4310');
const supervisorUrl = new URL(
  process.env.COMPUTER_SUPERVISOR_URL ?? 'http://127.0.0.1:4312',
);
const ownerToken = process.env.OWNER_TOKEN?.trim();
const supervisorToken = process.env.COMPUTER_SUPERVISOR_TOKEN?.trim();
const namespace = process.env.COMPUTER_NAMESPACE?.trim() || 'opendots';
const computerImage = process.env.COMPUTER_IMAGE?.trim() || 'opendots-computer:b6932d3';
const requestedDotId = process.env.DOT_ID?.trim();
const timeoutMs = Number.parseInt(process.env.COMPUTER_QUALIFY_TIMEOUT_MS ?? '90000', 10);
const allowRestart = process.env.COMPUTER_QUALIFY_ALLOW_RESTART === '1';

if (!ownerToken || !supervisorToken) {
  console.error('OWNER_TOKEN and COMPUTER_SUPERVISOR_TOKEN must be configured without printing their values.');
  process.exit(1);
}
for (const [label, url] of [
  ['OPENDOTS_BASE_URL', baseUrl],
  ['COMPUTER_SUPERVISOR_URL', supervisorUrl],
]) {
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.pathname !== '/') {
    console.error(label + ' must be an HTTP(S) origin without embedded credentials or a path.');
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
    fail('OpenDots API returned non-JSON content (HTTP ' + response.status + ').');
  }
  if (!response.ok) {
    const detail = typeof result?.error === 'string' ? ': ' + result.error.slice(0, 200) : '';
    fail('OpenDots API returned HTTP ' + response.status + detail);
  }
  return result;
}

async function supervisorExport(dotId, type) {
  const response = await fetch(
    new URL('/computers/' + encodeURIComponent(dotId) + '/export?type=' + encodeURIComponent(type), supervisorUrl.origin),
    {
      method: 'GET',
      redirect: 'error',
      signal: AbortSignal.timeout(timeoutMs),
      headers: { Authorization: 'Bearer ' + supervisorToken },
    },
  );
  if (!response.ok) {
    const detail = (await response.text()).slice(0, 200);
    fail('Supervisor export returned HTTP ' + response.status + (detail ? ': ' + detail : ''));
  }
  const declared = Number(response.headers.get('content-length') ?? '');
  const max = 600 * 1024 * 1024;
  if (Number.isFinite(declared) && declared > max) fail('Supervisor export exceeded 600 MiB.');
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
    new URL('/computers/' + encodeURIComponent(dotId) + '/import?type=' + encodeURIComponent(type), supervisorUrl.origin),
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
    fail('Supervisor import returned non-JSON content (HTTP ' + response.status + ').');
  }
  if (!response.ok || result.imported !== true) {
    const detail = typeof result?.error === 'string' ? ': ' + result.error.slice(0, 200) : '';
    fail('Supervisor import returned HTTP ' + response.status + detail);
  }
}

async function action(dotId, name, input) {
  return api('/dots/' + encodeURIComponent(dotId) + '/computer/actions', 'POST', {
    action: name,
    input,
  });
}

function runVolumeCommand(volumeName, mountPoint, command) {
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,254}$/.test(volumeName)) {
    fail('Refusing invalid Docker volume name.');
  }
  if (!['/workspace', '/profiles'].includes(mountPoint)) {
    fail('Refusing unexpected Docker volume mount point.');
  }
  execFileSync(
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
      '-lc',
      command,
    ],
    { encoding: 'utf8', stdio: 'pipe', timeout: timeoutMs, maxBuffer: 1_000_000 },
  );
}

function markerPath() {
  return 'opendots-supervisor-backup/marker-' + randomUUID().replaceAll('-', '') + '.txt';
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
    fail('Set DOT_ID to a disposable test Dot before running this script outside CI.');
  }

  const workspace = await api('/workspace');
  if (!Array.isArray(workspace.dots) || workspace.dots.length === 0) fail('No Dots exist in the OpenDots workspace.');
  const dot = requestedDotId
    ? workspace.dots.find((item) => item.id === requestedDotId)
    : workspace.dots[0];
  if (!dot) fail('DOT_ID does not match a Dot in the OpenDots workspace.');
  const dotId = dot.id;
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(dotId)) fail('Selected Dot ID is not valid for supervisor naming.');

  const originalStatus = await api('/dots/' + encodeURIComponent(dotId) + '/computer');
  const originalPermissions = originalStatus.permissions;
  if (!originalStatus.configured || originalStatus.state === 'unavailable' || originalStatus.state === 'not_configured') {
    fail('The selected Dot computer is not configured or the provider is unavailable.');
  }
  if (originalStatus.state === 'running' && !allowRestart) {
    fail('Selected computer is already running. Set COMPUTER_QUALIFY_ALLOW_RESTART=1 only for a disposable test Dot.');
  }

  const workspaceVolume = namespace + '-workspace-' + dotId;
  const profileVolume = namespace + '-profile-' + dotId;
  const workspaceFile = markerPath();
  const profileFile = markerPath();
  const workspaceMarker = 'workspace-archive-proof-' + randomUUID();
  const profileMarker = 'profile-archive-proof-' + randomUUID();
  const cookieName = 'odsb_' + randomUUID().replaceAll('-', '').slice(0, 16);
  const cookieValue = randomUUID().replaceAll('-', '');
  const cookie = cookieName + '=' + cookieValue + '; Path=/; Max-Age=3600; Secure; SameSite=Lax';

  let permissionsChanged = false;
  let touchedLifecycle = false;

  try {
    await api('/dots/' + encodeURIComponent(dotId) + '/computer/permissions', 'PATCH', {
      enabled: true,
      browser: true,
      files: true,
      shell: false,
    });
    permissionsChanged = true;

    await api('/dots/' + encodeURIComponent(dotId) + '/computer/start', 'POST', {});
    touchedLifecycle = true;

    // -------- Workspace archive round trip through the actual Docker supervisor --------
    await action(dotId, 'files_write', {
      path: workspaceFile,
      contents: workspaceMarker,
    });
    const check = await action(dotId, 'files_read', { path: workspaceFile });
    if (check.text !== workspaceMarker) fail('Workspace marker was not readable before export.');

    await api('/dots/' + encodeURIComponent(dotId) + '/computer/stop', 'POST', {});
    const workspaceArchive = await supervisorExport(dotId, 'workspace');
    assertEntry(workspaceArchive, 'workspace', workspaceFile, workspaceMarker);
    logPass('Real supervisor workspace export contains the expected marker.');

    runVolumeCommand(
      workspaceVolume,
      '/workspace',
      'rm -f -- ' + quoteShell('/workspace/' + workspaceFile) +
        ' && test ! -e ' + quoteShell('/workspace/' + workspaceFile),
    );
    await supervisorImport(dotId, 'workspace', workspaceArchive);
    logPass('Real supervisor accepted and imported the verified workspace archive.');

    await api('/dots/' + encodeURIComponent(dotId) + '/computer/start', 'POST', {});
    const restoredWorkspace = await action(dotId, 'files_read', { path: workspaceFile });
    if (restoredWorkspace.text !== workspaceMarker) fail('Workspace marker did not recover byte-for-byte after supervisor import.');
    logPass('Workspace marker recovered exactly after delete → export → import → read.');

    // -------- Browser-profile archive round trip through the actual volume --------
    const cookieSetter = new URL('https://httpbin.org/response-headers');
    cookieSetter.searchParams.set('Set-Cookie', cookie);
    const cookieSetup = await action(dotId, 'navigate', { url: cookieSetter.toString() });
    if (typeof cookieSetup.url !== 'string' || !cookieSetup.url.startsWith('https://httpbin.org/')) {
      fail('Could not reach the HTTPS cookie setup endpoint.');
    }
    const cookieBefore = await action(dotId, 'navigate', { url: 'https://httpbin.org/cookies' });
    if (typeof cookieBefore.text !== 'string' || !cookieBefore.text.includes(cookieName) || !cookieBefore.text.includes(cookieValue)) {
      fail('The controlled cookie was not present before profile export.');
    }

    await api('/dots/' + encodeURIComponent(dotId) + '/computer/stop', 'POST', {});
    runVolumeCommand(
      profileVolume,
      '/profiles',
      'mkdir -p ' + quoteShell('/profiles/' + dotId + '/opendots-supervisor-backup') +
        ' && printf %s ' + quoteShell(profileMarker) +
        ' > ' + quoteShell('/profiles/' + dotId + '/' + profileFile),
    );
    const profileArchive = await supervisorExport(dotId, 'browser-profile');
    const profileEntries = assertEntry(
      profileArchive,
      'browser-profile',
      profileFile,
      profileMarker,
    );
    if (!profileEntries.some((entry) => entry.path === 'Default/Cookies')) {
      fail('Browser-profile archive did not include Chromium Default/Cookies.');
    }
    logPass('Real supervisor browser-profile export contains the marker and Chromium cookie database.');

    runVolumeCommand(
      profileVolume,
      '/profiles',
      'rm -f -- ' + quoteShell('/profiles/' + dotId + '/' + profileFile) +
        ' && test ! -e ' + quoteShell('/profiles/' + dotId + '/' + profileFile),
    );
    await supervisorImport(dotId, 'browser-profile', profileArchive);
    runVolumeCommand(
      profileVolume,
      '/profiles',
      'test -f ' + quoteShell('/profiles/' + dotId + '/' + profileFile) +
        ' && test "$(cat ' + quoteShell('/profiles/' + dotId + '/' + profileFile) +
        ')" = ' + quoteShell(profileMarker),
    );
    logPass('Browser-profile marker recovered exactly after delete → export → import.');

    await api('/dots/' + encodeURIComponent(dotId) + '/computer/start', 'POST', {});
    const cookieAfter = await action(dotId, 'navigate', { url: 'https://httpbin.org/cookies' });
    if (typeof cookieAfter.text !== 'string' || !cookieAfter.text.includes(cookieName) || !cookieAfter.text.includes(cookieValue)) {
      fail('The browser cookie did not survive the real profile export/import.');
    }
    logPass('The real Chromium cookie survived supervisor browser-profile export/import.');
    console.log('SUPERVISOR ARCHIVE QUALIFICATION RESULT: PASS');
  } finally {
    // Never leave a production user's computer stopped or permissions changed.
    try {
      const status = await api('/dots/' + encodeURIComponent(dotId) + '/computer');
      if (status.state === 'running') await api('/dots/' + encodeURIComponent(dotId) + '/computer/stop', 'POST', {});
    } catch {}

    for (const [volume, mount, path] of [
      [workspaceVolume, '/workspace', '/workspace/' + workspaceFile],
      [profileVolume, '/profiles', '/profiles/' + dotId + '/' + profileFile],
    ]) {
      try {
        runVolumeCommand(volume, mount, 'rm -f -- ' + quoteShell(path));
      } catch {
        console.error('CLEANUP WARNING: a temporary supervisor archive marker may remain in a test volume.');
      }
    }

    try {
      if (originalStatus.state === 'running') {
        await api('/dots/' + encodeURIComponent(dotId) + '/computer/start', 'POST', {});
      } else {
        const status = await api('/dots/' + encodeURIComponent(dotId) + '/computer');
        if (status.state === 'running') await api('/dots/' + encodeURIComponent(dotId) + '/computer/stop', 'POST', {});
      }
    } catch {
      console.error('CLEANUP WARNING: could not restore the computer running/stopped state.');
    }
    if (permissionsChanged) {
      try {
        await api('/dots/' + encodeURIComponent(dotId) + '/computer/permissions', 'PATCH', originalPermissions);
      } catch {
        console.error('CLEANUP WARNING: could not restore the original computer permissions.');
      }
    }
    void touchedLifecycle;
  }
}

main().catch((error) => {
  console.error('SUPERVISOR ARCHIVE QUALIFICATION RESULT: FAIL — ' + (error instanceof Error ? error.message : 'unknown error'));
  process.exit(1);
});
