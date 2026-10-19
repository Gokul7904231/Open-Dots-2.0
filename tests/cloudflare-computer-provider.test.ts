import { afterEach, expect, it, vi } from 'vitest';
import type { PlatformConfig } from '../src/server/platform-config.js';
import { CloudflareContainerComputerProvider } from '../src/server/cloudflare-computer-provider.js';

const masterToken = 'test-master-computer-token-at-least-24-characters';
const providerToken = 'test-cloudflare-provider-token';

function config(overrides: Partial<PlatformConfig> = {}): PlatformConfig {
  return {
    baseUrl: 'https://example.com',
    voiceName: 'voice',
    slackUsers: [],
    runtimeUrl: 'http://localhost',
    computerToken: masterToken,
    cloudflareComputerApiUrl: 'https://opendots-computers.example.workers.dev',
    cloudflareComputerProviderToken: providerToken,
    ...overrides,
  };
}

afterEach(() => vi.restoreAllMocks());

it('returns only the configured Cloudflare origin for a running Dot', async () => {
  const calls: { url: string; init?: RequestInit }[] = [];
  const transport: typeof fetch = async (input, init) => {
    calls.push({ url: String(input), init });
    return Response.json({
      dotId: 'dot-1',
      status: 'running',
      endpoint: 'https://untrusted.example',
    });
  };
  const provider = new CloudflareContainerComputerProvider(config(), transport);
  await expect(provider.get('dot-1')).resolves.toEqual({
    dotId: 'dot-1',
    status: 'running',
    endpoint: 'https://opendots-computers.example.workers.dev',
  });
  expect(calls[0].url).toBe(
    'https://opendots-computers.example.workers.dev/__provider/computers/dot-1',
  );
  expect(new Headers(calls[0].init?.headers).get('authorization')).toBe(
    `Bearer ${providerToken}`,
  );
});

it('ensures and stops through protected lifecycle routes', async () => {
  const calls: { url: string; init?: RequestInit }[] = [];
  const transport: typeof fetch = async (input, init) => {
    calls.push({ url: String(input), init });
    return Response.json({
      dotId: 'dot_1',
      status: calls.length === 2 ? 'stopped' : 'running',
    });
  };
  const provider = new CloudflareContainerComputerProvider(config(), transport);
  await expect(provider.ensure('dot_1')).resolves.toMatchObject({
    dotId: 'dot_1',
    status: 'running',
    endpoint: 'https://opendots-computers.example.workers.dev',
  });
  await expect(provider.stop('dot_1')).resolves.toBeUndefined();
  expect(calls.map((call) => call.url)).toEqual([
    'https://opendots-computers.example.workers.dev/__provider/computers/dot_1/ensure',
    'https://opendots-computers.example.workers.dev/__provider/computers/dot_1/stop',
  ]);
});

it('rejects invalid endpoint origins, unexpected Dot IDs, and wrong identities', async () => {
  const providerWithBadUrl = new CloudflareContainerComputerProvider(
    config({
      cloudflareComputerApiUrl: 'https://api.example.workers.dev/path',
    }),
  );
  await expect(providerWithBadUrl.get('dot-1')).rejects.toThrow(
    /root HTTPS origin/i,
  );
  const provider = new CloudflareContainerComputerProvider(config(), async () =>
    Response.json({ dotId: 'other', status: 'running' }),
  );
  await expect(provider.get('../dot-1')).rejects.toThrow(
    /Invalid Dot identifier/i,
  );
  await expect(provider.get('dot-1')).rejects.toThrow(/wrong Dot identity/i);
});
