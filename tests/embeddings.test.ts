import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  clearEmbeddingMemoryCacheForTests,
  embeddingConfigured,
  retrieveRelevantMemories,
  type EmbeddingConfig,
} from '../src/server/embeddings.js';

const config: EmbeddingConfig = {
  apiBaseUrl: 'https://embeddings.example/v1',
  apiKey: 'test-api-key',
  model: 'embeddinggemma-2',
  dimensions: 128,
};
const signal = new AbortController().signal;
const vector = (axis: number) => {
  const values = Array.from({ length: 128 }, () => 0);
  values[axis] = 1;
  return values;
};
afterEach(() => {
  vi.unstubAllGlobals();
  clearEmbeddingMemoryCacheForTests();
});

describe('EmbeddingGemma memory retrieval', () => {
  it('is enabled only when both a base URL and API key are configured', () => {
    expect(embeddingConfigured(config)).toBe(true);
    expect(embeddingConfigured({ apiBaseUrl: config.apiBaseUrl })).toBe(false);
    expect(embeddingConfigured({ apiKey: config.apiKey })).toBe(false);
  });

  it('uses query/document tasks and ranks matching saved preferences first', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        Response.json({ data: [{ index: 0, embedding: vector(0) }] }),
      )
      .mockResolvedValueOnce(
        Response.json({
          data: [
            { index: 0, embedding: vector(1) },
            { index: 1, embedding: vector(0) },
          ],
        }),
      );
    vi.stubGlobal('fetch', fetchMock);

    const memories = [
      { id: 'cooking', text: 'I enjoy cooking at weekends.', createdAt: 2 },
      {
        id: 'writing',
        text: 'Prefer concise technical reports.',
        createdAt: 1,
      },
    ];
    const matches = await retrieveRelevantMemories(
      'Write a technical report',
      memories,
      config,
      signal,
    );

    expect(matches[0].id).toBe('writing');
    expect(matches[0].score).toBeCloseTo(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0][0]).toBe(
      'https://embeddings.example/v1/embeddings',
    );
    expect(fetchMock.mock.calls[0][1].headers.Authorization).toBe(
      '***',
    );
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toMatchObject({
      input: ['Write a technical report'],
      model: 'embeddinggemma-2',
      task: 'query',
      dimensions: 128,
    });
    expect(JSON.parse(fetchMock.mock.calls[1][1].body)).toMatchObject({
      input: memories.map((memory) => memory.text),
      task: 'document',
      dimensions: 128,
    });
  });

  it('validates vectors rather than silently accepting a mismatched dimension', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(
          Response.json({ data: [{ index: 0, embedding: [1, 0] }] }),
        ),
    );
    await expect(
      retrieveRelevantMemories(
        'Search query',
        [{ id: 'm1', text: 'Remember this', createdAt: 1 }],
        config,
        signal,
      ),
    ).rejects.toThrow('malformed vector');
  });

  it('does not make network requests for an empty query or empty memory set', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    await expect(
      retrieveRelevantMemories('  ', [], config, signal),
    ).resolves.toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
