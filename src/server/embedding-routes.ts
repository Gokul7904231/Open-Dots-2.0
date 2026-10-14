import { Hono } from 'hono';
import { z } from 'zod';
import {
  EmbeddingGemmaClient,
  EmbeddingProviderError,
  type EmbeddingTask,
} from './embedding-gemma.js';

const taskSchema = z.enum([
  'query',
  'document',
  'code_query',
  'qa',
  'fact_check',
  'classification',
  'clustering',
  'similarity',
]);
const textSchema = z.string().trim().min(1).max(100_000);
const requestSchema = z
  .object({
    input: z.union([textSchema, z.array(textSchema).min(1).max(16)]),
    task: taskSchema.optional(),
    dimensions: z.union([z.literal(128), z.literal(256), z.literal(512), z.literal(768)]).optional(),
  })
  .strict();

export function embeddingRoutes(client: EmbeddingGemmaClient) {
  const app = new Hono();

  app.get('/embedding/status', async (c) => c.json(await client.status()));

  app.post('/embeddings', async (c) => {
    const parsed = requestSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) {
      return c.json(
        {
          error:
            'Provide non-empty text input (up to 16 strings), a supported task, and an optional dimension of 128, 256, 512, or 768.',
        },
        400,
      );
    }
    try {
      const result = await client.embed(
        parsed.data.input,
        (parsed.data.task ?? 'query') as EmbeddingTask,
        parsed.data.dimensions,
        c.req.raw.signal,
      );
      return c.json(result);
    } catch (error) {
      const status = error instanceof EmbeddingProviderError ? error.status : 502;
      return c.json(
        {
          error:
            error instanceof EmbeddingProviderError
              ? error.message
              : 'Embedding request failed.',
        },
        status as 400 | 502 | 503 | 504,
      );
    }
  });

  return app;
}
