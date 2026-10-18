/* global process, URL, fetch, AbortSignal, console */
import { randomUUID } from 'node:crypto';

const baseUrl = new URL(
  process.env.OPENDOTS_BASE_URL ?? 'http://127.0.0.1:4310',
);
const ownerToken = process.env.OWNER_TOKEN?.trim();
const requestedDotId = process.env.DOT_ID?.trim();
const timeoutMs = Number.parseInt(
  process.env.COMPUTER_QUALIFY_TIMEOUT_MS ?? '90000',
  10,
);
const allowRestart = process.env.COMPUTER_QUALIFY_ALLOW_RESTART === '1';
const keepRunning = process.env.COMPUTER_QUALIFY_KEEP_RUNNING === '1';
const cookieProbe = process.env.COMPUTER_QUALIFY_COOKIE_PROBE !== '0';

if (
  !['http:', 'https:'].includes(baseUrl.protocol) ||
  baseUrl.username ||
  baseUrl.password
) {
  console.error(
    'OPENDOTS_BASE_URL must be a valid HTTP(S) origin without embedded credentials.',
  );
  process.exit(1);
}
if (!ownerToken) {
  console.error(
    'OWNER_TOKEN is required. Set it in .env or the environment; do not paste it into chat.',
  );
  process.exit(1);
}
if (
  !Number.isSafeInteger(timeoutMs) ||
  timeoutMs < 1000 ||
  timeoutMs > 300000
) {
  console.error('COMPUTER_QUALIFY_TIMEOUT_MS must be between 1000 and 300000.');
  process.exit(1);
}

function logPass(message) {
  console.log(`PASS  ${message}`);
}

function fail(message) {
  throw new Error(message);
}

async function request(path, method = 'GET', body) {
  let response;
  try {
    response = await fetch(new URL(`/api${path}`, baseUrl.origin), {
      method,
      redirect: 'error',
      signal: AbortSignal.timeout(timeoutMs),
      headers: {
        Authorization: `Bearer ${ownerToken}`,
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  } catch (error) {
    const reason =
      error instanceof Error && error.name === 'TimeoutError'
        ? 'request timed out'
        : 'connection failed';
    fail(
      `${method} ${path}: ${reason}. Check OPENDOTS_BASE_URL and that OpenDots is reachable.`,
    );
  }

  const raw = await response.text();
  if (raw.length > 4_000_000)
    fail(`${method} ${path}: response exceeded 4 MB.`);
  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    fail(`${method} ${path}: expected JSON, received HTTP ${response.status}.`);
  }
  if (!response.ok) {
    const detail =
      typeof data?.error === 'string' ? `: ${data.error.slice(0, 240)}` : '';
    fail(`${method} ${path} returned HTTP ${response.status}${detail}`);
  }
  return data;
}

const encodedDotId = (id) => encodeURIComponent(id);
const computerPath = (id) => `/dots/${encodedDotId(id)}/computer`;
const action = (id, name, input) =>
  request(`${computerPath(id)}/actions`, 'POST', { action: name, input });
const status = (id) => request(computerPath(id));
const start = (id) => request(`${computerPath(id)}/start`, 'POST', {});
const stop = (id) => request(`${computerPath(id)}/stop`, 'POST', {});
const patchPermissions = (id, permissions) =>
  request(`${computerPath(id)}/permissions`, 'PATCH', permissions);

let dotId;
let originalStatus;
let originalPermissions;
let permissionsChanged = false;
let proofWritten = false;
let testComputerStarted = false;
let cleanupRequested = false;

async function run() {
  const workspace = await request('/workspace');
  if (!Array.isArray(workspace.dots) || workspace.dots.length === 0) {
    fail('OpenDots returned no Dots at /api/workspace.');
  }
  const dot = requestedDotId
    ? workspace.dots.find((candidate) => candidate.id === requestedDotId)
    : workspace.dots[0];
  if (!dot) fail('DOT_ID does not match a Dot in this OpenDots workspace.');
  dotId = dot.id;

  originalStatus = await status(dotId);
  originalPermissions = originalStatus.permissions;
  if (!originalStatus.configured || originalStatus.state === 'not_configured') {
    fail(
      'The selected Dot computer is not configured. Configure COMPUTER_PROVIDER and its runtime credentials first.',
    );
  }
  if (originalStatus.state === 'unavailable') {
    fail(
      'The selected Dot computer provider is unavailable. Repair provider connectivity before qualification.',
    );
  }
  if (originalStatus.state === 'running' && !allowRestart) {
    fail(
      'This Dot already has a running computer. To test stop/start recovery without surprising you, rerun with COMPUTER_QUALIFY_ALLOW_RESTART=1.',
    );
  }

  console.log(
    `Qualifying one computer through OpenDots API (provider selection is configured server-side).`,
  );
  console.log(`Dot: ${dot.name ?? 'selected Dot'} (${dotId})`);
  console.log(`Base URL: ${baseUrl.origin}`);

  permissionsChanged = true;
  await patchPermissions(dotId, {
    enabled: true,
    browser: true,
    files: true,
    shell: false,
  });
  logPass(
    'Enabled browser and workspace-file permissions; shell remains disabled.',
  );

  const started = await start(dotId);
  testComputerStarted = true;
  if (started.state !== 'running') {
    fail(
      `Provider did not report the computer as running (state: ${started.state ?? 'unknown'}).`,
    );
  }
  logPass(
    'Provisioned/recovered one Dot computer and received running status.',
  );

  const navigation = await action(dotId, 'navigate', {
    url: 'https://example.com/',
  });
  if (
    typeof navigation.url !== 'string' ||
    !navigation.url.startsWith('https://example.com/') ||
    navigation.title !== 'Example Domain' ||
    typeof navigation.text !== 'string' ||
    navigation.text.trim().length === 0
  ) {
    const diagnostic = {
      url: typeof navigation.url === 'string' ? navigation.url : null,
      title: typeof navigation.title === 'string' ? navigation.title : null,
      textPreview:
        typeof navigation.text === 'string'
          ? navigation.text.slice(0, 180)
          : null,
    };
    fail(
      `Browser navigation did not return the expected URL, title, and readable page text. Safe page diagnostic: ${JSON.stringify(diagnostic)}`,
    );
  }
  logPass('Chromium navigated to a real HTTPS page and returned page text.');

  const proofPath = 'opendots-qualification/proof.txt';
  const proofMarker = `opendots-qualification-${randomUUID().replaceAll('-', '')}`;
  const proofText = `OpenDots computer qualification proof\nmarker=${proofMarker}\ncreatedAt=${new Date().toISOString()}\n`;
  await action(dotId, 'files_write', {
    path: proofPath,
    contents: proofText,
  });
  const initialFile = await action(dotId, 'files_read', { path: proofPath });
  if (
    typeof initialFile.text !== 'string' ||
    !initialFile.text.includes(proofMarker)
  ) {
    fail(
      'A file written through OpenDots could not be read back with its proof marker.',
    );
  }
  proofWritten = true;
  logPass('Wrote and read back a per-Dot workspace file.');

  let cookieName;
  let cookieValue;
  if (cookieProbe) {
    cookieName = `odq_${randomUUID().replaceAll('-', '').slice(0, 16)}`;
    cookieValue = randomUUID().replaceAll('-', '');
    const cookie = `${cookieName}=${cookieValue}; Path=/; Secure; SameSite=Lax`;
    const setter = new URL('https://httpbin.org/response-headers');
    setter.searchParams.set('Set-Cookie', cookie);
    const cookieSetup = await action(dotId, 'navigate', {
      url: setter.toString(),
    });
    if (
      typeof cookieSetup.url !== 'string' ||
      !cookieSetup.url.startsWith('https://httpbin.org/')
    ) {
      fail(
        'Browser profile probe could not reach the HTTPS cookie test endpoint (httpbin.org).',
      );
    }
    logPass(
      'Set a unique HTTPS browser-profile cookie before the restart test.',
    );
  } else {
    console.log(
      'SKIP  Cookie/session persistence probe disabled by COMPUTER_QUALIFY_COOKIE_PROBE=0.',
    );
  }

  await stop(dotId);
  const stopped = await status(dotId);
  if (stopped.state !== 'stopped') {
    fail(
      `Provider did not report stopped state after stop (state: ${stopped.state ?? 'unknown'}).`,
    );
  }
  testComputerStarted = false;
  logPass('Stopped the computer without requesting destructive reset.');

  const recovered = await start(dotId);
  testComputerStarted = true;
  if (recovered.state !== 'running') {
    fail(
      `Computer did not recover after restart (state: ${recovered.state ?? 'unknown'}).`,
    );
  }
  logPass('Restarted the same Dot computer.');

  const recoveredFile = await action(dotId, 'files_read', { path: proofPath });
  if (
    typeof recoveredFile.text !== 'string' ||
    !recoveredFile.text.includes(proofMarker)
  ) {
    fail(
      'Workspace proof marker did not survive stop/start. Persistent volume qualification failed.',
    );
  }
  logPass('Workspace file survived stop/start.');

  if (cookieProbe) {
    const cookieCheck = await action(dotId, 'navigate', {
      url: 'https://httpbin.org/cookies',
    });
    if (
      typeof cookieCheck.text !== 'string' ||
      !cookieCheck.text.includes(cookieName) ||
      !cookieCheck.text.includes(cookieValue)
    ) {
      fail(
        'The unique browser cookie did not survive stop/start. Browser-profile persistence qualification failed.',
      );
    }
    logPass(
      'Browser cookie survived stop/start, proving profile data persisted.',
    );
  }

  console.log('');
  console.log('QUALIFICATION RESULT: PASS');
  console.log(
    'This proves the currently configured provider passed this live one-Dot run.',
  );
  console.log(
    'It does not prove free-tier eligibility, perpetual availability, regional availability, or a cloud-provider SLA.',
  );
}

async function cleanup() {
  if (!permissionsChanged || keepRunning) return;
  try {
    const current = await status(dotId);
    if (originalStatus.state === 'running') {
      if (current.state !== 'running') await start(dotId);
    } else if (testComputerStarted || current.state === 'running') {
      await stop(dotId);
    }
  } catch {
    console.error(
      'CLEANUP WARNING: could not fully restore the computer lifecycle state; inspect the Dot Computer panel.',
    );
  }
  try {
    await patchPermissions(dotId, originalPermissions);
    cleanupRequested = true;
    logPass('Restored the Dot’s original permissions.');
  } catch {
    console.error(
      'CLEANUP WARNING: could not restore the original permissions; inspect the Dot Computer panel.',
    );
  }
}

try {
  await run();
} catch (error) {
  console.error(
    `QUALIFICATION RESULT: FAIL — ${error instanceof Error ? error.message : 'unknown error'}`,
  );
  process.exitCode = 1;
} finally {
  if (dotId) await cleanup();
  if (keepRunning && testComputerStarted) {
    console.log(
      'Computer left running with browser/files enabled and shell disabled by request.',
    );
  } else if (cleanupRequested && proofWritten) {
    console.log(
      'Cleanup complete. The qualification proof file is intentionally retained for future recovery checks.',
    );
  } else if (cleanupRequested) {
    console.log('Cleanup complete. Original permissions restored.');
  }
}
