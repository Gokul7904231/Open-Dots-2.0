import type { Memory } from '../shared/types.js';

const SUPPORTED_DIMENSIONS = new Set([128, 256, 512, 768]);
const MAX_BATCH_SIZE = 16;
const MAX_RETRIEVED_MEMORIES = 8;
const REQUEST_TIMEOUT_MS = 12_000;
const MAX_CACHED_MEMORIES = 500;

export interface EmbeddingConfig {
  apiBaseUrl?: string;
  apiKey?: string;
  model?: string;
  dimensions?: number;
}

export interface MemoryMatch {
  id: string;
  text: string;
  score: number;
}

interface CachedVector {
  text: string;
  vector: number[];
}

const memoryVectorCache = new Map<string, CachedVector>();

export function embeddingConfigured(config: EmbeddingConfig): boolean {
  return Boolean(config.apiBaseUrl?.trim() && config.apiKey?.trim());
}

function normalizedBaseUrl(config: EmbeddingConfig): string {
  const baseUrl = config.apiBaseUrl?.trim().replace(/\/+$/, '');
  if (!baseUrl) throw new Error('Embedding API base URL is not configured.');
  let parsed: URL;
  try {
    parsed = new URL(baseUrl);
  } catch {
    throw new Error('Embedding API base URL must be a valid HTTP(S) URL.');
  }
  if (
    parsed.protocol !== 'https:' &&
    parsed.hostname !== 'localhost' &&
    parsed.hostname !== '127.0.0.1' &&
    parsed.hostname !== '[::1]'
  ) {
    throw new Error(
      'Embedding API must use HTTPS unless it is accessed over loopback.',
    );
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new Error('Embedding API base URL must use HTTP(S).');
  }
  return baseUrl;
}

function dimensionsFor(config: EmbeddingConfig): number {
  const dimensions = config.dimensions ?? 768;
  if (!Number.isInteger(dimensions) || !SUPPORTED_DIMENSIONS.has(dimensions)) {
    throw new Error(
      'Embedding dimensions must be one of 128, 256, 512, or 768.',
    );
  }
  return dimensions;
}

async function requestEmbeddings(
  inputs: string[],
  task: 'query' | 'document',
  config: EmbeddingConfig,
  signal: AbortSignal,
): Promise<number[][]> {
  if (!config.apiKey?.trim())
    throw new Error('Embedding API key is not configured.');
  const baseUrl = normalizedBaseUrl(config);
  const dimensions = dimensionsFor(config);
  const timeoutSignal = AbortSignal.any([
    signal,
    AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  ]);
  const response = await fetch(`${baseUrl}/embeddings`, {
    method: 'POST',
    headers: {
      Authorization: 'Bearer ' + config.apiKey,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      input: inputs,
      model: config.model?.trim() || 'embeddinggemma-2',
      task,
      dimensions,
    }),
    signal: timeoutSignal,
  });
  if (!response.ok) {
    throw new Error(`Embedding API returned HTTP ${response.status}.`);
  }
  const payload: unknown = await response.json();
  if (
    !payload ||
    typeof payload !== 'object' ||
    !Array.isArray((payload as { data?: unknown }).data)
  ) {
    throw new Error('Embedding API returned an invalid response.');
  }
  const data = (
    payload as { data: Array<{ index?: number; embedding?: unknown }> }
  ).data;
  if (data.length !== inputs.length) {
    throw new Error('Embedding API returned an unexpected number of vectors.');
  }
  const ordered = [...data].sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
  return ordered.map((item) => {
    if (
      !Array.isArray(item.embedding) ||
      item.embedding.length !== dimensions ||
      !item.embedding.every(
        (value) => typeof value === 'number' && Number.isFinite(value),
      )
    ) {
      throw new Error('Embedding API returned a malformed vector.');
    }
    return item.embedding as number[];
  });
}

function cosineSimilarity(left: number[], right: number[]): number {
  if (left.length !== right.length || left.length === 0) return -1;
  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;
  for (let i = 0; i < left.length; i++) {
    dot += left[i] * right[i];
    leftNorm += left[i] * left[i];
    rightNorm += right[i] * right[i];
  }
  if (!leftNorm || !rightNorm) return -1;
  return dot / (Math.sqrt(leftNorm) * Math.sqrt(rightNorm));
}

function cacheVector(memory: Memory, vector: number[]) {
  memoryVectorCache.delete(memory.id);
  memoryVectorCache.set(memory.id, { text: memory.text, vector });
  while (memoryVectorCache.size > MAX_CACHED_MEMORIES) {
    const oldest = memoryVectorCache.keys().next().value;
    if (oldest === undefined) break;
    memoryVectorCache.delete(oldest);
  }
}

/**
 * Return up to eight saved preferences ranked by EmbeddingGemma semantic similarity.
 * Memory document vectors are cached per server process. Failures are intentionally
 * surfaced to the caller so it can report a degraded fallback instead of claiming
 * semantic matching succeeded.
 */
export async function retrieveRelevantMemories(
  query: string,
  memories: Memory[],
  config: EmbeddingConfig,
  signal: AbortSignal,
): Promise<MemoryMatch[]> {
  if (!embeddingConfigured(config))
    throw new Error('Embedding API is not configured.');
  const cleanedQuery = query.trim();
  if (!cleanedQuery || memories.length === 0) return [];

  const [queryVector] = await requestEmbeddings(
    [cleanedQuery],
    'query',
    config,
    signal,
  );
  const vectors: Array<number[] | undefined> = memories.map((memory) => {
    const cached = memoryVectorCache.get(memory.id);
    return cached?.text === memory.text ? cached.vector : undefined;
  });
  const missingIndices = memories
    .map((_memory, index) => index)
    .filter((index) => !vectors[index]);

  for (
    let offset = 0;
    offset < missingIndices.length;
    offset += MAX_BATCH_SIZE
  ) {
    const indices = missingIndices.slice(offset, offset + MAX_BATCH_SIZE);
    const batch = indices.map((index) => memories[index].text);
    const batchVectors = await requestEmbeddings(
      batch,
      'document',
      config,
      signal,
    );
    indices.forEach((memoryIndex, batchIndex) => {
      vectors[memoryIndex] = batchVectors[batchIndex];
      cacheVector(memories[memoryIndex], batchVectors[batchIndex]);
    });
  }

  return memories
    .map((memory, index) => ({
      id: memory.id,
      text: memory.text,
      score: cosineSimilarity(queryVector, vectors[index] ?? []),
      createdAt: memory.createdAt,
    }))
    .sort((a, b) => b.score - a.score || b.createdAt - a.createdAt)
    .slice(0, MAX_RETRIEVED_MEMORIES)
    .map(({ id, text, score }) => ({ id, text, score }));
}

/** Useful for tests that need to guarantee a fresh embedding cache. */
export function clearEmbeddingMemoryCacheForTests(): void {
  memoryVectorCache.clear();
}
