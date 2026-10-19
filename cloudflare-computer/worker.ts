import { createHmac } from 'node:crypto';
import { DurableObject } from 'cloudflare:workers';

interface NamespaceLike {
  idFromName(name: string): unknown;
  get(id: unknown): { fetch(request: Request): Promise<Response> };
}
export interface Env {
  DOT_COMPUTERS: NamespaceLike;
  COMPUTER_PROVIDER_TOKEN: string;
  COMPUTER_TOKEN: string;
}
interface SnapshotHandle { id: string; size?: number; name?: string; }
interface DotState {
  dotId: string;
  status: 'running' | 'stopped' | 'starting' | 'failed';
  endpoint?: string;
  snapshotCreatedAt?: number;
}
interface ContainerLike {
  running: boolean;
  images: Record<string, string>;
  start(options: {
    image?: string;
    containerSnapshot?: { id: string };
    instance: string;
    enableInternet: boolean;
    env: Record<string, string>;
    labels?: Record<string, string>;
  }): void;
  setInactivityTimeout(durationMs: number | bigint): Promise<void>;
  getTcpPort(port: number): { fetch(request: Request): Promise<Response> };
  snapshotContainer(options: { name: string }): Promise<SnapshotHandle>;
  destroy(reason?: string): Promise<void>;
}
interface StorageLike {
  get<T>(key: string): Promise<T | undefined>;
  put<T>(key: string, value: T): Promise<void>;
  setAlarm(timestamp: number | Date): Promise<void>;
}
interface ContextLike {
  storage: StorageLike;
  container?: ContainerLike;
}

const COMPUTER_PORT = 4100;
const INSTANCE = 'standard-1';
const IDLE_SNAPSHOT_MS = 5 * 60 * 1000;
const MAX_INACTIVITY_MS = 6 * 60 * 60 * 1000;
const SNAPSHOT_RENEW_MS = 25 * 24 * 60 * 60 * 1000;
const READY_ATTEMPTS = 30;
const READY_DELAY_MS = 1000;
const DOT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const CONTROL_PREFIX = '/__provider/computers/';

function json(data: unknown, status = 200): Response {
  return Response.json(data, {
    status,
    headers: {
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
    },
  });
}
function constantTimeEqual(left: string, right: string): boolean {
  const max = Math.max(left.length, right.length);
  let diff = left.length ^ right.length;
  for (let i = 0; i < max; i++) {
    diff |= (left.charCodeAt(i) || 0) ^ (right.charCodeAt(i) || 0);
  }
  return diff === 0;
}
function validDotId(value: string | null): value is string {
  return !!value && DOT_ID_PATTERN.test(value);
}
function providerTokenMatches(request: Request, env: Env): boolean {
  const offered = request.headers.get('authorization')?.replace(/^Bearer\s+/i, '').trim() ?? '';
  const expected = env.COMPUTER_PROVIDER_TOKEN?.trim() ?? '';
  return !!expected && constantTimeEqual(offered, expected);
}
function dotToken(master: string, dotId: string): string {
  return createHmac('sha256', master.trim()).update(`opendots-computer:${dotId}`).digest('hex');
}
function computerTokenMatches(request: Request, env: Env, dotId: string): boolean {
  const bearer = request.headers.get('authorization')?.replace(/^Bearer\s+/i, '').trim() ?? '';
  const alternate = request.headers.get('x-openbot-computer-token')?.trim() ?? '';
  const offered = alternate || bearer;
  return !!env.COMPUTER_TOKEN?.trim() && constantTimeEqual(offered, dotToken(env.COMPUTER_TOKEN, dotId));
}
function containerFrom(ctx: unknown): ContainerLike | undefined {
  return (ctx as ContextLike).container;
}
function storageFrom(ctx: unknown): StorageLike {
  return (ctx as ContextLike).storage;
}
function stateResponse(state: DotState): Response {
  return json(state, state.status === 'failed' ? 503 : 200);
}
async function readiness(container: ContainerLike): Promise<boolean> {
  for (let attempt = 0; attempt < READY_ATTEMPTS; attempt++) {
    if (!container.running) return false;
    try {
      const response = await container.getTcpPort(COMPUTER_PORT).fetch(
        new Request('http://container/health', { method: 'GET' }),
      );
      if (response.ok) return true;
    } catch {
      // A newly started container may not have bound port 4100 yet.
    }
    await new Promise((resolve) => setTimeout(resolve, READY_DELAY_MS));
  }
  return false;
}

export class DotComputer extends DurableObject<Env> {
  private starting?: Promise<void>;
  private context(): ContextLike { return this.ctx as unknown as ContextLike; }
  private container(): ContainerLike {
    const container = containerFrom(this.ctx);
    if (!container) throw new Error('Cloudflare has no container attached to DotComputer.');
    return container;
  }
  private async bindDot(dotId: string): Promise<boolean> {
    if (!validDotId(dotId)) return false;
    const storage = storageFrom(this.ctx);
    const current = await storage.get<string>('dotId');
    if (current && current !== dotId) return false;
    if (!current) await storage.put('dotId', dotId);
    return true;
  }
  private async savedSnapshot(): Promise<SnapshotHandle | undefined> {
    return storageFrom(this.ctx).get<SnapshotHandle>('snapshot');
  }
  private async configureInactivity(container: ContainerLike): Promise<void> {
    if (container.running) await container.setInactivityTimeout(MAX_INACTIVITY_MS);
  }
  private async scheduleIdleSnapshot(): Promise<void> {
    const storage = storageFrom(this.ctx);
    const now = Date.now();
    await storage.put('lastActivityAt', now);
    await storage.setAlarm(now + IDLE_SNAPSHOT_MS);
  }
  private async startContainer(dotId: string, mode: 'interactive' | 'maintenance'): Promise<void> {
    const container = this.container();
    if (container.running) {
      await this.configureInactivity(container);
      if (mode === 'interactive') await this.scheduleIdleSnapshot();
      return;
    }
    if (this.starting) {
      await this.starting;
      return;
    }
    this.starting = (async () => {
      const snapshot = await this.savedSnapshot();
      const env = {
        COMPUTER_TOKEN: dotToken(this.env.COMPUTER_TOKEN, dotId),
        COMPUTER_BOT_ID: dotId,
        COMPUTER_BROWSER_MODE: 'headless',
        COMPUTER_BROWSER_BACKEND: 'managed',
        WORKSPACE_DIR: '/workspace',
        PROFILES_DIR: '/profiles',
        PORT: String(COMPUTER_PORT),
      };
      if (snapshot) {
        container.start({
          containerSnapshot: { id: snapshot.id },
          instance: INSTANCE,
          enableInternet: true,
          env,
          labels: { dot: dotId },
        });
      } else {
        const image = container.images.base;
        if (!image) throw new Error('Cloudflare computer image is not configured.');
        container.start({ image, instance: INSTANCE, enableInternet: true, env, labels: { dot: dotId } });
      }
      await container.setInactivityTimeout(MAX_INACTIVITY_MS);
      if (!(await readiness(container))) {
        throw new Error('Cloudflare computer container did not become healthy on port 4100.');
      }
      if (mode === 'interactive') await this.scheduleIdleSnapshot();
    })().finally(() => { this.starting = undefined; });
    await this.starting;
  }
  private async state(dotId: string): Promise<DotState> {
    const container = this.container();
    const storage = storageFrom(this.ctx);
    const snapshot = await this.savedSnapshot();
    const snapshotCreatedAt = await storage.get<number>('snapshotCreatedAt');
    if (!container.running) {
      return { dotId, status: 'stopped', ...(snapshot ? { snapshotCreatedAt } : {}) };
    }
    await this.configureInactivity(container);
    try {
      const response = await container.getTcpPort(COMPUTER_PORT).fetch(
        new Request('http://container/health', { method: 'GET' }),
      );
      return { dotId, status: response.ok ? 'running' : 'starting', ...(snapshot ? { snapshotCreatedAt } : {}) };
    } catch {
      return { dotId, status: 'starting' };
    }
  }
  private async stopAndSnapshot(dotId: string): Promise<DotState> {
    const container = this.container();
    const storage = storageFrom(this.ctx);
    if (!container.running) {
      const snapshot = await this.savedSnapshot();
      if (snapshot) {
        const createdAt = (await storage.get<number>('snapshotCreatedAt')) ?? Date.now();
        await storage.setAlarm(createdAt + SNAPSHOT_RENEW_MS);
      }
      return { dotId, status: 'stopped' };
    }
    const snapshot = await container.snapshotContainer({ name: `opendots-${dotId}-${Date.now()}` });
    const createdAt = Date.now();
    await storage.put('snapshot', snapshot);
    await storage.put('snapshotCreatedAt', createdAt);
    await container.destroy('OpenDots computer stopped after a filesystem snapshot.');
    await storage.setAlarm(createdAt + SNAPSHOT_RENEW_MS);
    return { dotId, status: 'stopped', snapshotCreatedAt: createdAt };
  }
  private async routeInternal(request: Request, url: URL): Promise<Response> {
    const dotId = request.headers.get('x-opendots-dot-id');
    if (!validDotId(dotId) || !(await this.bindDot(dotId))) {
      return json({ error: 'Invalid or mismatched Dot identity.' }, 403);
    }
    if (url.pathname === '/__internal/state' && request.method === 'GET') {
      return stateResponse(await this.state(dotId));
    }
    if (url.pathname === '/__internal/ensure' && request.method === 'POST') {
      try {
        await this.startContainer(dotId, 'interactive');
        return stateResponse(await this.state(dotId));
      } catch {
        return json({ dotId, status: 'failed', error: 'Cloudflare could not start the computer container.' }, 503);
      }
    }
    if (url.pathname === '/__internal/stop' && request.method === 'POST') {
      try {
        return stateResponse(await this.stopAndSnapshot(dotId));
      } catch {
        return json({ dotId, status: 'failed', error: 'Cloudflare could not snapshot and stop the computer.' }, 503);
      }
    }
    return json({ error: 'Unknown internal computer operation.' }, 404);
  }
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname.startsWith('/__internal/')) {
      if (!providerTokenMatches(request, this.env)) return json({ error: 'Not authorized.' }, 401);
      return this.routeInternal(request, url);
    }
    const dotId = request.headers.get('x-openbot-bot-id');
    if (!validDotId(dotId) || !(await this.bindDot(dotId))) {
      return json({ error: 'Invalid or mismatched Dot identity.' }, 403);
    }
    if (!computerTokenMatches(request, this.env, dotId)) return json({ error: 'Not authorized.' }, 401);
    const container = this.container();
    if (!container.running) {
      return json({ error: 'This Dot computer is stopped. Start it before sending computer actions.' }, 503);
    }
    await this.scheduleIdleSnapshot();
    await this.configureInactivity(container);
    const target = new URL(request.url);
    const forwarded = new Request(`http://container${target.pathname}${target.search}`, request);
    try {
      return await container.getTcpPort(COMPUTER_PORT).fetch(forwarded);
    } catch {
      return json({ error: 'The Cloudflare computer runtime is temporarily unavailable.' }, 502);
    }
  }
  async alarm(): Promise<void> {
    const storage = storageFrom(this.ctx);
    const container = this.container();
    const snapshot = await this.savedSnapshot();
    const now = Date.now();
    if (container.running) {
      const lastActivity = (await storage.get<number>('lastActivityAt')) ?? 0;
      if (now < lastActivity + IDLE_SNAPSHOT_MS) {
        await storage.setAlarm(lastActivity + IDLE_SNAPSHOT_MS);
        return;
      }
      const dotId = await storage.get<string>('dotId');
      if (dotId) {
        try {
          await this.stopAndSnapshot(dotId);
        } catch {
          await storage.setAlarm(now + 60_000);
        }
      }
      return;
    }
    if (!snapshot) return;
    const createdAt = (await storage.get<number>('snapshotCreatedAt')) ?? now;
    if (now < createdAt + SNAPSHOT_RENEW_MS) {
      await storage.setAlarm(createdAt + SNAPSHOT_RENEW_MS);
      return;
    }
    const dotId = await storage.get<string>('dotId');
    if (!dotId) return;
    try {
      await this.startContainer(dotId, 'maintenance');
      const renewed = await container.snapshotContainer({ name: `opendots-${dotId}-renewed-${Date.now()}` });
      const renewedAt = Date.now();
      await storage.put('snapshot', renewed);
      await storage.put('snapshotCreatedAt', renewedAt);
      await container.destroy('OpenDots refreshed an idle computer filesystem snapshot.');
      await storage.setAlarm(renewedAt + SNAPSHOT_RENEW_MS);
    } catch {
      await storage.setAlarm(now + 24 * 60 * 60 * 1000);
    }
  }
}

async function proxyProviderOperation(request: Request, env: Env, url: URL): Promise<Response> {
  if (!providerTokenMatches(request, env)) return json({ error: 'Not authorized.' }, 401);
  const match = url.pathname.match(/^\/__provider\/computers\/([A-Za-z0-9][A-Za-z0-9_-]{0,63})(?:\/(ensure|stop))?$/);
  if (!match) return json({ error: 'Invalid provider route.' }, 404);
  const dotId = match[1];
  const operation = match[2];
  if (!operation && request.method !== 'GET') return json({ error: 'Method not allowed.' }, 405);
  if (operation && request.method !== 'POST') return json({ error: 'Method not allowed.' }, 405);
  const stub = env.DOT_COMPUTERS.get(env.DOT_COMPUTERS.idFromName(dotId));
  const internalPath = operation === 'ensure' ? '/__internal/ensure' : operation === 'stop' ? '/__internal/stop' : '/__internal/state';
  const internalRequest = new Request(`https://dot-computer.internal${internalPath}`, {
    method: operation ? 'POST' : 'GET',
    headers: { 'x-opendots-dot-id': dotId, Authorization: `Bearer ${env.COMPUTER_PROVIDER_TOKEN}` },
  });
  const response = await stub.fetch(internalRequest);
  if (!response.ok) {
    return new Response(await response.text(), { status: response.status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
  }
  const state = (await response.json()) as DotState;
  if (state.status === 'running') state.endpoint = url.origin;
  return json(state);
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    try {
      if (url.pathname === '/_health' && request.method === 'GET') {
        return json({ ok: true, runtime: 'cloudflare-container-computers' });
      }
      if (url.pathname.startsWith(CONTROL_PREFIX)) return proxyProviderOperation(request, env, url);
      const dotId = request.headers.get('x-openbot-bot-id');
      if (!validDotId(dotId) || !computerTokenMatches(request, env, dotId)) {
        return json({ error: 'Not authorized.' }, 401);
      }
      const stub = env.DOT_COMPUTERS.get(env.DOT_COMPUTERS.idFromName(dotId));
      return await stub.fetch(new Request(request.url, request));
    } catch (error) {
      console.error('Cloudflare computer gateway failed:', error instanceof Error ? error.name : 'unknown');
      return json({ error: 'Cloudflare computer request failed.' }, 502);
    }
  },
};
