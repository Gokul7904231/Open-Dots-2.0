import { afterEach, expect, it, vi } from 'vitest';
import { createHash, createHmac } from 'node:crypto';
import type { PlatformConfig } from '../src/server/platform-config.js';
import { DaytonaComputerProvider } from '../src/server/daytona-computer-provider.js';

const token = 'test-daytona-api-key';
const masterComputerToken = 'a-master-computer-token-long-enough-for-tests';
function sandboxName(dotId: string) {
  return 'od-' + createHash('sha256').update(`opendots:${dotId}`).digest('hex').slice(0, 24);
}

function makeResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function config(overrides: Partial<PlatformConfig> = {}): PlatformConfig {
  return {
    baseUrl: 'https://example.com',
    voiceName: 'voice',
    slackUsers: [],
    runtimeUrl: 'http://localhost',
    daytonaApiKey: token,
    computerToken: masterComputerToken,
    daytonaApiBaseUrl: 'https://app.daytona.io/api',
    daytonaToolboxBaseUrl: 'https://proxy.app.daytona.io/toolbox',
    ...overrides,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

it('uses a private, port-scoped signed preview URL and never asks for a public sandbox', async () => {
  const calls: { url: string; init?: RequestInit }[] = [];
  const name = sandboxName('dot-1');
  const response: typeof fetch = async (input, init) => {
    const url = String(input);
    calls.push({ url, init });
    if (url.endsWith(`/sandbox/${name}`)) {
      return makeResponse({ id: 'sandbox-id', name, state: 'started', labels: {
        'opendots-namespace': 'opendots',
        'opendots-dot-id': 'dot-1',
      } });
    }
    if (url.includes('/signed-preview-url')) {
      return makeResponse({ url: 'https://4100-test-token.proxy.daytona.work' });
    }
    if (url === 'https://4100-test-token.proxy.daytona.work/health') {
      return new Response('ok', { status: 200 });
    }
    throw new Error(`Unexpected request: ${url}`);
  };
  const provider = new DaytonaComputerProvider(config(), response);
  const result = await provider.get('dot-1');
  expect(result).toEqual({
    dotId: 'dot-1',
    status: 'running',
    endpoint: 'https://4100-test-token.proxy.daytona.work',
  });
  expect(calls.some((call) => call.url.endsWith('/ports/4100/signed-preview-url?expiresInSeconds=3600'))).toBe(true);
  const createCall = calls.find((call) => call.url.endsWith('/sandbox') && call.init?.method === 'POST');
  expect(createCall).toBeUndefined();
  expect(calls[0].init?.headers).toBeDefined();
});

it('creates a sandbox privately, derives the same per-Dot HMAC token as OpenDots, and starts its computer', async () => {
  const name = sandboxName('dot-1');
  const calls: { url: string; init?: RequestInit }[] = [];
  let created = false;
  let launched = false;
  const response: typeof fetch = async (input, init) => {
    const url = String(input);
    calls.push({ url, init });
    if (url.endsWith('/sandbox/od-test')) {
      return created
        ? makeResponse({ id: 'sandbox-id', name, state: 'started', labels: {
            'opendots-namespace': 'opendots', 'opendots-dot-id': 'dot-1',
          } })
        : makeResponse({ message: 'missing' }, 404);
    }
    if (url.endsWith('/sandbox') && init?.method === 'POST') {
      created = true;
      const body = JSON.parse(String(init.body));
      expect(body.public).toBe(false);
      expect(body.autoStopInterval).toBe(0);
      expect(body.buildInfo.dockerfileContent).toContain('b6932d31a8d6e7896c15139dfc27a6c6911deb27');
      expect(body.labels['opendots-dot-id']).toBe('dot-1');
      return makeResponse({ id: 'sandbox-id', name, state: 'started', labels: body.labels });
    }
    if (url.includes('/signed-preview-url')) {
      return makeResponse({ url: 'https://4100-test-token.proxy.daytona.work' });
    }
    if (url === 'https://4100-test-token.proxy.daytona.work/health') {
      return launched ? makeResponse({ ok: true }) : makeResponse({ ok: false }, 503);
    }
    if (url.endsWith('/process/execute')) {
      launched = true;
      const body = JSON.parse(String(init?.body));
      const expected = createHmac('sha256', masterComputerToken)
        .update('opendots-computer:dot-1').digest('hex');
      expect(body.env.COMPUTER_TOKEN).toBe(expected);
      expect(body.env.COMPUTER_BOT_ID).toBe('dot-1');
      return makeResponse({ exitCode: 0 });
    }
    if (url.endsWith('/sandbox/sandbox-id/start')) return makeResponse({ ok: true });
    throw new Error(`Unexpected request: ${url}`);
  };
  const provider = new DaytonaComputerProvider(config(), response);
  const result = await provider.ensure('dot-1');
  expect(result.status).toBe('running');
  expect(result.endpoint).toBe('https://4100-test-token.proxy.daytona.work');
  expect(calls.some((call) => call.url.endsWith('/sandbox') && call.init?.method === 'POST')).toBe(true);
  const computerLaunch = calls.find((call) => call.url.endsWith('/process/execute'));
  expect(computerLaunch).toBeDefined();
  expect(String(computerLaunch?.init?.body)).not.toContain(token);
});

it('rejects a foreign sandbox name or malformed signed endpoint', async () => {
  const response: typeof fetch = async (input) => {
    const url = String(input);
    if (url.includes('/sandbox/')) {
      return makeResponse({ id: 'sandbox-id', name: 'some-other-sandbox', state: 'started' });
    }
    throw new Error(`Unexpected request: ${url}`);
  };
  const provider = new DaytonaComputerProvider(config(), response);
  await expect(provider.get('dot-1')).rejects.toThrow(/name does not match/i);
});
