import type { Context, Hono, Next } from 'hono';

type ResolvedNames =
  | { ok: true; names: { botId: string } & Record<string, string> }
  | { ok: false; reason: string };

export function attachBackupRoutes(
  app: Hono,
  resolve: (raw: string) => ResolvedNames,
): void;
export function lifecycleGuard(
  context: Context,
  next: Next,
): Promise<Response | void>;
export function isBackupLocked(botId: string): boolean;
