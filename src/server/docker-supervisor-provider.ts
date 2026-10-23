import { z } from 'zod';
import type { PlatformConfig } from './platform-config.js';
import type {
  ComputerProvider,
  ComputerProviderState,
} from './computer-provider.js';
import type { BackupType } from './backup/types.js';

const supervisorComputerSchema = z.object({
  botId: z.string(),
  container: z.string(),
  status: z.string(),
  port: z.number().int().min(1024).max(65535).optional(),
  url: z.string().optional(),
});
const computerListingSchema = z.object({
  computers: z.array(supervisorComputerSchema),
});

const MAX_BACKUP_TRANSFER_BYTES = 600 * 1024 * 1024;
const BACKUP_TRANSFER_TIMEOUT_MS = 5 * 60 * 1000;

async function readLimitedResponse(
  response: Response,
  maximum: number,
): Promise<Buffer> {
  const declaredLength = Number(response.headers.get('content-length') ?? '');
  if (Number.isFinite(declaredLength) && declaredLength > maximum) {
    await response.body?.cancel();
    throw new Error('Computer supervisor backup exceeded its size limit.');
  }
  if (!response.body)
    throw new Error('Computer supervisor returned an empty backup.');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.length;
      if (total > maximum) {
        await reader.cancel();
        throw new Error('Computer supervisor backup exceeded its size limit.');
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks);
}

/**
 * Adapter for the existing OpenBot supervisor + Docker Engine implementation.
 * Keep all Docker names, supervisor HTTP paths, and loopback/network checks here;
 * alternate providers should implement ComputerProvider instead of extending this.
 */
export class DockerSupervisorComputerProvider implements ComputerProvider {
  readonly id = 'docker-supervisor';

  constructor(
    private readonly config: PlatformConfig,
    private readonly transport: typeof fetch = fetch,
    private readonly deadlineMs = 70000,
  ) {}

  get configured() {
    return !!(
      this.config.computerSupervisorUrl?.trim() &&
      this.config.computerSupervisorToken?.trim()
    );
  }

  private requireDotId(dotId: string) {
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(dotId))
      throw new Error('Invalid Dot identifier for computer provider.');
  }

  private namespace() {
    const namespace = this.config.computerNamespace?.trim() || 'opendots';
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(namespace))
      throw new Error('Invalid computer namespace.');
    return namespace;
  }

  private async json(
    path: string,
    body?: unknown,
    signal?: AbortSignal,
  ): Promise<unknown> {
    if (!this.configured)
      throw new Error('Computer provider is not configured.');
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.deadlineMs);
    const combined = signal
      ? AbortSignal.any([signal, controller.signal])
      : controller.signal;
    try {
      const base = this.config.computerSupervisorUrl!.trim().replace(/\/$/, '');
      const response = await this.transport(`${base}${path}`, {
        method: body === undefined ? 'GET' : 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.config.computerSupervisorToken!.trim()}`,
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        redirect: 'error',
        signal: combined,
      });
      if (!response.ok)
        throw new Error(`Computer provider returned HTTP ${response.status}.`);
      if (!response.body)
        throw new Error('Computer provider returned an empty response.');
      const reader = response.body.getReader();
      let size = 0;
      const chunks: Uint8Array[] = [];
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.length;
        if (size > 4_000_000) {
          await reader.cancel();
          throw new Error(
            'Computer provider response exceeded its size limit.',
          );
        }
        chunks.push(value);
      }
      let text = Buffer.concat(chunks).toString('utf8');
      for (const secret of [
        this.config.computerSupervisorToken?.trim(),
        this.config.computerToken?.trim(),
      ]) {
        if (secret) text = text.split(secret).join('[redacted]');
      }
      return JSON.parse(text);
    } catch (error) {
      if (combined.aborted)
        throw new Error(
          'Computer provider request was cancelled or timed out.',
          {
            cause: error,
          },
        );
      if (
        error instanceof Error &&
        /^Computer provider (returned HTTP|response exceeded)/.test(
          error.message,
        )
      )
        throw error;
      throw new Error(
        'Computer provider is unavailable or returned an invalid response.',
        { cause: error },
      );
    } finally {
      clearTimeout(timeout);
    }
  }

  private normalize(raw: unknown, dotId: string): ComputerProviderState {
    const state = supervisorComputerSchema.parse(raw);
    const expectedContainer = `${this.namespace()}-computer-${dotId}`;
    if (state.botId !== dotId || state.container !== expectedContainer)
      throw new Error('Computer provider identity mismatch.');

    // Docker endpoint validation is deliberately stricter than the generic
    // contract: only the expected service DNS name or the configured local
    // loopback port is accepted.
    const supervisorUrl = new URL(this.config.computerSupervisorUrl!);
    const url = new URL(
      state.url ??
        (state.port
          ? `http://127.0.0.1:${state.port}`
          : `http://${expectedContainer}:4100`),
    );
    const network =
      url.hostname === expectedContainer.toLowerCase() && url.port === '4100';
    const local =
      url.hostname === '127.0.0.1' &&
      !!state.port &&
      url.port === String(state.port) &&
      supervisorUrl.hostname === '127.0.0.1';
    if (
      url.protocol !== 'http:' ||
      url.username ||
      url.password ||
      url.pathname !== '/' ||
      url.search ||
      url.hash ||
      (!network && !local)
    )
      throw new Error('Computer endpoint is not bound to this Dot.');

    return {
      dotId,
      status: state.status === 'running' ? 'running' : 'stopped',
      endpoint: url.origin,
    };
  }

  async get(
    dotId: string,
    signal?: AbortSignal,
  ): Promise<ComputerProviderState | undefined> {
    this.requireDotId(dotId);
    const listing = computerListingSchema.parse(
      await this.json('/computers', undefined, signal),
    );
    const state = listing.computers.find(
      (computer) => computer.botId === dotId,
    );
    return state ? this.normalize(state, dotId) : undefined;
  }

  async ensure(
    dotId: string,
    signal?: AbortSignal,
  ): Promise<ComputerProviderState> {
    this.requireDotId(dotId);
    const state = await this.json(`/computers/${dotId}/ensure`, {}, signal);
    return this.normalize(state, dotId);
  }

  async stop(dotId: string, signal?: AbortSignal): Promise<void> {
    this.requireDotId(dotId);
    await this.json(`/computers/${dotId}/stop`, {}, signal);
  }

  async exportData(
    dotId: string,
    type: BackupType,
    signal?: AbortSignal,
  ): Promise<Buffer> {
    this.requireDotId(dotId);
    if (!this.configured)
      throw new Error('Computer provider is not configured.');
    const base = this.config.computerSupervisorUrl!.trim().replace(/\/$/, '');
    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(),
      Math.max(this.deadlineMs, BACKUP_TRANSFER_TIMEOUT_MS),
    );
    const combined = signal
      ? AbortSignal.any([signal, controller.signal])
      : controller.signal;

    try {
      const response = await this.transport(
        `${base}/computers/${dotId}/export?type=${encodeURIComponent(type)}`,
        {
          method: 'GET',
          headers: {
            Authorization: `Bearer ${this.config.computerSupervisorToken!.trim()}`,
          },
          redirect: 'error',
          signal: combined,
        },
      );
      if (!response.ok) {
        throw new Error(
          `Computer supervisor export failed with HTTP ${response.status}${await this.failureDetail(response)}.`,
        );
      }
      return await readLimitedResponse(response, MAX_BACKUP_TRANSFER_BYTES);
    } finally {
      clearTimeout(timeout);
    }
  }

  async importData(
    dotId: string,
    type: BackupType,
    data: Buffer,
    signal?: AbortSignal,
  ): Promise<void> {
    this.requireDotId(dotId);
    if (!this.configured)
      throw new Error('Computer provider is not configured.');
    if (data.length > MAX_BACKUP_TRANSFER_BYTES) {
      throw new Error('Computer supervisor backup exceeded its size limit.');
    }
    const base = this.config.computerSupervisorUrl!.trim().replace(/\/$/, '');
    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(),
      Math.max(this.deadlineMs, BACKUP_TRANSFER_TIMEOUT_MS),
    );
    const combined = signal
      ? AbortSignal.any([signal, controller.signal])
      : controller.signal;

    try {
      const response = await this.transport(
        `${base}/computers/${dotId}/import?type=${encodeURIComponent(type)}`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/octet-stream',
            Authorization: `Bearer ${this.config.computerSupervisorToken!.trim()}`,
          },
          body: new Uint8Array(data),
          redirect: 'error',
          signal: combined,
        },
      );
      if (!response.ok) {
        throw new Error(
          `Computer supervisor import failed with HTTP ${response.status}${await this.failureDetail(response)}.`,
        );
      }
    } finally {
      clearTimeout(timeout);
    }
  }

  /**
   * The supervisor's own bounded error string (for example, "Stop the computer before
   * exporting"). Never includes a token: it is redacted even though the supervisor
   * does not echo it.
   */
  private async failureDetail(response: Response): Promise<string> {
    try {
      const text = (await response.text()).slice(0, 2000);
      const parsed: unknown = JSON.parse(text);
      const message =
        parsed && typeof parsed === 'object' && 'error' in parsed
          ? (parsed as { error: unknown }).error
          : undefined;
      if (typeof message !== 'string' || !message) return '';
      let safe = message.slice(0, 200);
      for (const secret of [
        this.config.computerSupervisorToken?.trim(),
        this.config.computerToken?.trim(),
      ])
        if (secret) safe = safe.split(secret).join('[redacted]');
      return `: ${safe}`;
    } catch {
      return '';
    }
  }
}
