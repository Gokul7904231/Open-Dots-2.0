import { describe, expect, it, vi } from 'vitest';
import { EmbeddingGemmaClient } from '../src/server/embedding-gemma.js';
import { createApp } from '../src/server/app.js';
import { Store } from '../src/server/store.js';
import { Runner } from '../src/server/runner.js';
import type { Config } from '../src/server/research.js';

const env = {
  OPENAI_EMBEDDING_BASE_URL: 'https://embeddings.example/v1',
  OPENAI_EMBEDDING_API_KEY: 'secret-for-test-only',
  OPENAI_EMBEDDING_MODEL: 'embeddinggemma-2',
  OPENAI_EMBEDDING_DIMENSIONS: '768',
};
const vector = Array.from({ length: 768 }, (_, index) =>
  index === 0 ? 1 : 0,
);

function fakeFetch(
  handler: (url: string, init?: RequestInit) => Promise<Response>,
): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) =>
    handler(String(input), init)) as typeof fetch;
}

describe('EmbeddingGemma client', () => {
  it('reports the optional provider as not configured without a URL or key', async () => {
    const client = new EmbeddingGemmaClient({});
    expect(await client.status()).toMatchObject({
      state: 'not_configured',
      configured: false,
      reachable: false,
    });
    await expect(client.embed('hello')).rejects.toThrow(/not configured/i);
  });

  it('rejects partial or unsafe remote configuration without calling the provider', async () => {
    const fetcher = vi.fn();
    const partial = new EmbeddingGemmaClient(
      { OPENAI_EMBEDDING_BASE_URL: env.OPENAI_EMBEDDING_BASE_URL },
      fetcher as unknown as typeof fetch,
    );
    expect((await partial.status()).state).toBe('misconfigured');

    const unsafe = new EmbeddingGemmaClient(
      {
        ...env,
        OPENAI_EMBEDDING_BASE_URL: 'http://embeddings.example/v1',
      },
      fetcher as unknown as typeof fetch,
    );
    expect((await unsafe.status()).state).toBe('misconfigured');
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('checks provider health without returning a key or base URL', async () => {
    const fetcher = fakeFetch(async (url) => {
      expect(url).toBe('https://embeddings.example/health');
      return new Response(
        JSON.stringify({ status: 'ok', model: 'embeddinggemma-2' }),
        {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        },
      );
    });
    const client = new EmbeddingGemmaClient(env, fetcher);
    expect(await client.status()).toEqual({
      state: 'ready',
      configured: true,
      reachable: true,
      model: 'embeddinggemma-2',
      dimensions: 768,
    });
  });

  it('forwards authenticated requests server-side and validates vector dimensions', async () => {
    const fetcher = fakeFetch(async (url, init) => {
      expect(url).toBe('https://embeddings.example/v1/embeddings');
      expect(new Headers(init?.headers).get('authorization')).toBe(
        'Bearer secret-for-test-only',
      );
      expect(JSON.parse(String(init?.body))).toMatchObject({
        input: 'test phrase',
        model: 'embeddinggemma-2',
        task: 'query',
        dimensions: 768,
      });
      return new Response(
        JSON.stringify({
          object: 'list',
          data: [{ object: 'embedding', index: 0, embedding: vector }],
          model: 'embeddinggemma-2',
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    });
    const client = new EmbeddingGemmaClient(env, fetcher);
    const result = await client.embed('test phrase');
    expect(result.data[0].embedding).toHaveLength(768);
    expect(result.dimensions).toBe(768);
    expect(JSON.stringify(result)).not.toContain('secret-for-test-only');
  });

  it('supports batch inputs and rejects invalid vector responses', async () => {
    const fetcher = fakeFetch(async (_url, init) => {
      const input = JSON.parse(String(init?.body)).input as string[];
      return new Response(
        JSON.stringify({
          data: input.map((_, index) => ({ index, embedding: vector })),
          model: 'embeddinggemma-2',
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    });
    const client = new EmbeddingGemmaClient(env, fetcher);
    const result = await client.embed(['first', 'second'], 'document');
    expect(result.data).toHaveLength(2);
    await expect(client.embed(['   '])).rejects.toThrow(/non-empty text inputs/i);

    const malformed = new EmbeddingGemmaClient(
      env,
      fakeFetch(
        async () =>
          new Response(JSON.stringify({ data: [{ embedding: [0.1] }] }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          }),
      ),
    );
    await expect(malformed.embed('broken response')).rejects.toThrow(
      /malformed vector/i,
    );
  });
});

it('mounts embedding routes behind the existing OpenDots owner-token guard', async () => {
  const store = new Store(':memory:');
  const config: Config = {
    mode: 'sample',
    baseUrl: 'https://api.openai.com/v1',
  };
  const runner = new Runner(store, config);
  const client = new EmbeddingGemmaClient(
    env,
    fakeFetch(
      async () =>
        new Response(
          JSON.stringify({
            data: [{ index: 0, embedding: vector }],
            model: 'embeddinggemma-2',
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
    ),
  );
  const app = createApp({
    store,
    runner,
    config,
    ownerToken: 'this-is-a-long-test-owner-token',
    embeddingGemma: client,
  });
  try {
    const denied = await app.request('/api/embeddings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ input: 'private request' }),
    });
    expect(denied.status).toBe(401);

    const accepted = await app.request('/api/embeddings', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer this-is-a-long-test-owner-token',
      },
      body: JSON.stringify({ input: 'private request' }),
    });
    expect(accepted.status).toBe(200);
    expect((await accepted.json()).dimensions).toBe(768);
  } finally {
    store.close();
  }
});
