import { describe, expect, it, vi } from 'vitest';
import { DockerSupervisorComputerProvider } from '../src/server/docker-supervisor-provider.js';

const config = {
  baseUrl: 'http://localhost',
  voiceName: 'voice',
  slackUsers: [],
  runtimeUrl: 'http://localhost',
  computerToken: 'unit-test-master-token-0123456789',
  computerSupervisorUrl: 'http://127.0.0.1:4312',
  computerSupervisorToken: 'unit-test-supervisor-token-0123456789',
};

function provider(transport: unknown) {
  return new DockerSupervisorComputerProvider(
    config,
    transport as typeof fetch,
    1000,
  );
}

describe('Docker supervisor backup client', () => {
  it('requests the exact export route with the management token and no redirects', async () => {
    const transport = vi.fn(async () => new Response(Buffer.from([1, 2, 3])));
    const data = await provider(transport).exportData(
      'dot-1',
      'browser-profile',
    );
    expect([...data]).toEqual([1, 2, 3]);
    const [url, init] = transport.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    expect(url).toBe(
      'http://127.0.0.1:4312/computers/dot-1/export?type=browser-profile',
    );
    expect(init.method).toBe('GET');
    expect(init.redirect).toBe('error');
    expect((init.headers as Record<string, string>).Authorization).toBe(
      `Bearer ${config.computerSupervisorToken}`,
    );
  });

  it('posts the archive to the exact import route as a binary body', async () => {
    const transport = vi.fn(async () => Response.json({ imported: true }));
    await provider(transport).importData(
      'dot-1',
      'workspace',
      Buffer.from([9, 8, 7]),
    );
    const [url, init] = transport.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    expect(url).toBe(
      'http://127.0.0.1:4312/computers/dot-1/import?type=workspace',
    );
    expect(init.method).toBe('POST');
    expect(init.redirect).toBe('error');
    expect(new Uint8Array(init.body as Uint8Array)).toEqual(
      new Uint8Array([9, 8, 7]),
    );
  });

  it('refuses invalid Dot ids before any request is sent', async () => {
    const transport = vi.fn();
    const p = provider(transport);
    await expect(p.exportData('../etc', 'workspace')).rejects.toThrow();
    await expect(
      p.importData('a/b', 'workspace', Buffer.alloc(1)),
    ).rejects.toThrow();
    expect(transport).not.toHaveBeenCalled();
  });

  it('surfaces the supervisor error text but never a token', async () => {
    const leaked = `Stop the computer first ${config.computerSupervisorToken}`;
    const transport = vi.fn(async () =>
      Response.json({ error: leaked }, { status: 409 }),
    );
    const error = await provider(transport)
      .exportData('dot-1', 'workspace')
      .catch((caught: Error) => caught);
    expect((error as Error).message).toMatch(
      /HTTP 409: Stop the computer first \[redacted\]/,
    );
    expect((error as Error).message).not.toContain(
      config.computerSupervisorToken,
    );
  });

  it('rejects a response that exceeds the transfer limit', async () => {
    const transport = vi.fn(
      async () =>
        new Response('x', {
          headers: { 'content-length': String(700 * 1024 * 1024) },
        }),
    );
    await expect(
      provider(transport).exportData('dot-1', 'workspace'),
    ).rejects.toThrow(/size limit/);
  });

  it('rejects an upload that exceeds the transfer limit without sending it', async () => {
    const transport = vi.fn();
    const oversized = { length: 700 * 1024 * 1024 } as unknown as Buffer;
    await expect(
      provider(transport).importData('dot-1', 'workspace', oversized),
    ).rejects.toThrow(/size limit/);
    expect(transport).not.toHaveBeenCalled();
  });

  it('propagates a redirect refusal instead of following it with the token', async () => {
    const transport = vi.fn(async () => {
      throw new TypeError('fetch failed: unexpected redirect');
    });
    await expect(
      provider(transport).exportData('dot-1', 'workspace'),
    ).rejects.toThrow(/redirect/);
  });

  it('streams export data in chunks with backpressure and size limits', async () => {
    const chunk1 = new Uint8Array([1, 2, 3]);
    const chunk2 = new Uint8Array([4, 5, 6]);
    const readable = new ReadableStream({
      start(controller) {
        controller.enqueue(chunk1);
        controller.enqueue(chunk2);
        controller.close();
      },
    });
    const transport = vi.fn(async () => new Response(readable));
    const stream = await provider(transport).exportDataStream!(
      'dot-1',
      'workspace',
    );
    const received: Uint8Array[] = [];
    for await (const chunk of stream) {
      received.push(chunk);
    }
    expect(Buffer.concat(received)).toEqual(Buffer.from([1, 2, 3, 4, 5, 6]));
    const [url, init] = transport.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    expect(url).toBe(
      'http://127.0.0.1:4312/computers/dot-1/export?type=workspace&format=gzip-tar-v1',
    );
    expect(init.method).toBe('GET');
  });

  it('streams import data to supervisor import route', async () => {
    const transport = vi.fn(async () => Response.json({ imported: true }));
    async function* source() {
      yield new Uint8Array([10, 20]);
      yield new Uint8Array([30, 40]);
    }
    await provider(transport).importDataStream!(
      'dot-1',
      'browser-profile',
      source(),
    );
    const [url, init] = transport.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    expect(url).toBe(
      'http://127.0.0.1:4312/computers/dot-1/import?type=browser-profile',
    );
    expect(init.method).toBe('POST');
    expect(init.headers).toMatchObject({
      'Content-Type': 'application/octet-stream',
      Authorization: `Bearer ${config.computerSupervisorToken}`,
    });
  });

  it('rejects exportDataStream when stream exceeds transfer limit', async () => {
    const largeChunk = new Uint8Array(350 * 1024 * 1024);
    const readable = new ReadableStream({
      start(controller) {
        controller.enqueue(largeChunk);
        controller.enqueue(largeChunk);
        controller.close();
      },
    });
    const transport = vi.fn(async () => new Response(readable));
    const stream = await provider(transport).exportDataStream!(
      'dot-1',
      'workspace',
    );
    await expect(async () => {
      for await (const chunk of stream) {
        void chunk;
      }
    }).rejects.toThrow(/size limit/);
  });
});
