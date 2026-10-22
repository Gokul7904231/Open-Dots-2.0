import { Hono } from 'hono';
import { z } from 'zod';
import type { ComputerService } from './computer-service.js';
import type { ComputerAction } from '../shared/computer-types.js';
import { dotIdSchema, backupIdSchema } from './backup/types.js';

const backupTypeSchema = z.enum([
  'workspace',
  'browser-profile',
  'full-computer',
]);

export function computerRoutes(computers: ComputerService) {
  const app = new Hono();
  app.onError((error, c) =>
    c.json(
      {
        error:
          error instanceof z.ZodError
            ? 'Invalid computer request.'
            : error.message,
      },
      error instanceof z.ZodError
        ? 400
        : error.message.includes('not found')
          ? 404
          : error.message.includes('disabled') ||
              error.message.includes('owner-only')
            ? 403
            : 400,
    ),
  );
  app.get('/dots/:id/computer', async (c) =>
    c.json(await computers.status(c.req.param('id'))),
  );
  app.patch('/dots/:id/computer/permissions', async (c) =>
    c.json(await computers.permissions(c.req.param('id'), await c.req.json())),
  );
  app.post('/dots/:id/computer/start', async (c) =>
    c.json(await computers.start(c.req.param('id'))),
  );
  app.post('/dots/:id/computer/stop', async (c) =>
    c.json(await computers.stop(c.req.param('id'))),
  );
  app.post('/dots/:id/computer/take', async (c) =>
    c.json(await computers.control(c.req.param('id'), 'take')),
  );
  app.post('/dots/:id/computer/release', async (c) =>
    c.json(await computers.control(c.req.param('id'), 'release')),
  );
  app.post('/dots/:id/computer/actions', async (c) => {
    const body = z
      .object({ action: z.string(), input: z.unknown() })
      .strict()
      .parse(await c.req.json());
    return c.json(
      await computers.action(
        c.req.param('id'),
        body.action as ComputerAction,
        body.input,
        'owner',
        c.req.raw.signal,
      ),
    );
  });

  // Durable B2 Computer Backup and Restore API
  app.get('/dots/:id/computer/backups', async (c) => {
    const dotId = dotIdSchema.parse(c.req.param('id'));
    const rawType = c.req.query('type');
    const type = rawType ? backupTypeSchema.parse(rawType) : undefined;
    const backups = await computers.listBackups(dotId, type, c.req.raw.signal);
    return c.json({ backups });
  });

  const createBackupInput = z
    .object({
      type: backupTypeSchema.default('workspace'),
    })
    .strict();

  app.post('/dots/:id/computer/backups', async (c) => {
    const dotId = dotIdSchema.parse(c.req.param('id'));
    const json = await c.req.json().catch(() => ({}));
    const body = createBackupInput.parse(json);
    const envelope = await computers.snapshot(
      dotId,
      body.type,
      undefined,
      c.req.raw.signal,
    );
    return c.json({ backup: envelope }, 201);
  });

  app.post('/dots/:id/computer/backup', async (c) => {
    const dotId = dotIdSchema.parse(c.req.param('id'));
    const json = await c.req.json().catch(() => ({}));
    const body = createBackupInput.parse(json);
    const envelope = await computers.snapshot(
      dotId,
      body.type,
      undefined,
      c.req.raw.signal,
    );
    return c.json({ backup: envelope }, 201);
  });

  const restoreBackupInput = z
    .object({
      backupId: backupIdSchema.optional(),
      type: backupTypeSchema.default('workspace'),
    })
    .strict();

  app.post('/dots/:id/computer/backups/:backupId/restore', async (c) => {
    const dotId = dotIdSchema.parse(c.req.param('id'));
    const backupId = backupIdSchema.parse(c.req.param('backupId'));
    const json = await c.req.json().catch(() => ({}));
    const body = restoreBackupInput.parse(json);
    const result = await computers.restore(
      dotId,
      backupId,
      body.type,
      c.req.raw.signal,
    );
    return c.json({
      restored: true,
      backupId: result.backupId,
      type: result.type,
      dotId: result.dotId,
      byteLength: result.byteLength,
    });
  });

  app.post('/dots/:id/computer/restore', async (c) => {
    const dotId = dotIdSchema.parse(c.req.param('id'));
    const json = await c.req.json().catch(() => ({}));
    const body = z
      .object({
        backupId: backupIdSchema,
        type: backupTypeSchema.default('workspace'),
      })
      .strict()
      .parse(json);
    const result = await computers.restore(
      dotId,
      body.backupId,
      body.type,
      c.req.raw.signal,
    );
    return c.json({
      restored: true,
      backupId: result.backupId,
      type: result.type,
      dotId: result.dotId,
      byteLength: result.byteLength,
    });
  });

  return app;
}
