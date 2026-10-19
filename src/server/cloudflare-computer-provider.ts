import type { PlatformConfig } from './platform-config.js';
import type {
  ComputerProvider,
  ComputerProviderState,
} from './computer-provider.js';

interface JsonObject {
  [key: string]: unknown;
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function validDotId(dotId: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(dotId);
}

/** Client adapter for OpenDots' standalone Cloudflare Worker + Container gateway. */
export class CloudflareContainerComputerProvider implements ComputerProvider {
  readonly id = 'cloudflare-containers';

  constructor(
    private readonly config: PlatformConfig,
    private readonly transport: typeof fetch = fetch,
    private readonly requestTimeoutMs = 70000,
  ) {}

  get configured(): boolean {
    return !!(
      this.config.cloudflareComputerApiUrl?.trim() &&
      this.config.cloudflareComputerProviderToken?.trim() &&
      this.config.computerToken?.trim()
    );
  }

  private origin(): string {
    const raw = this.config.cloudflareComputerApiUrl?.trim();
    if (!raw) throw new Error('Cloudflare computer API URL is not configured.');
    const url = new URL(raw);
    if (
      url.protocol !== 'https:' ||
      url.username ||
      url.password ||
      url.pathname !== '/' ||
      url.search ||
      url.hash
    ) {
      throw new Error(
        'Cloudflare computer API URL must be a root HTTPS origin.',
      );
    }
    return url.origin;
  }

  private async request(
    path: string,
    method: 'GET' | 'POST',
    signal?: AbortSignal,
  ): Promise<unknown> {
    if (!this.configured)
      throw new Error('Cloudflare computer provider is not configured.');
    const controller = new AbortController();
    const combined = signal
      ? AbortSignal.any([signal, controller.signal])
      : controller.signal;
    const timeout = setTimeout(() => controller.abort(), this.requestTimeoutMs);
    try {
      const response = await this.transport(`${this.origin()}${path}`, {
        method,
        headers: {
          Accept: 'application/json',
          Authorization: `Bearer ${this.config.cloudflareComputerProviderToken!.trim()}`,
        },
        redirect: 'error',
        signal: combined,
      });
      if (!response.ok) {
        throw new Error(
          `Cloudflare computer provider returned HTTP ${response.status}.`,
        );
      }
      if (!response.body)
        throw new Error(
          'Cloudflare computer provider returned an empty response.',
        );
      const reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let size = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.length;
        if (size > 100_000) {
          await reader.cancel();
          throw new Error(
            'Cloudflare computer provider response exceeded its size limit.',
          );
        }
        chunks.push(value);
      }
      let text = Buffer.concat(chunks).toString('utf8');
      for (const secret of [
        this.config.cloudflareComputerProviderToken?.trim(),
        this.config.computerToken?.trim(),
      ]) {
        if (secret) text = text.split(secret).join('[redacted]');
      }
      try {
        return JSON.parse(text) as unknown;
      } catch {
        throw new Error(
          'Cloudflare computer provider returned malformed JSON.',
        );
      }
    } catch (error) {
      if (combined.aborted) {
        throw new Error(
          'Cloudflare computer provider request was cancelled or timed out.',
          {
            cause: error,
          },
        );
      }
      if (
        error instanceof Error &&
        /^Cloudflare computer provider (returned HTTP|returned an empty|response exceeded)/.test(
          error.message,
        )
      ) {
        throw error;
      }
      throw new Error(
        'Cloudflare computer provider is unavailable or returned an invalid response.',
        {
          cause: error,
        },
      );
    } finally {
      clearTimeout(timeout);
    }
  }

  private parseState(
    value: unknown,
    expectedDotId: string,
  ): ComputerProviderState {
    if (!isObject(value) || value.dotId !== expectedDotId) {
      throw new Error(
        'Cloudflare computer provider returned the wrong Dot identity.',
      );
    }
    const status = value.status;
    if (
      !['running', 'stopped', 'starting', 'failed'].includes(String(status))
    ) {
      throw new Error(
        'Cloudflare computer provider returned an invalid lifecycle status.',
      );
    }
    return {
      dotId: expectedDotId,
      status: status as ComputerProviderState['status'],
      ...(status === 'running' ? { endpoint: this.origin() } : {}),
    };
  }

  async get(
    dotId: string,
    signal?: AbortSignal,
  ): Promise<ComputerProviderState | undefined> {
    if (!validDotId(dotId))
      throw new Error(
        'Invalid Dot identifier for Cloudflare computer provider.',
      );
    const state = await this.request(
      `/__provider/computers/${encodeURIComponent(dotId)}`,
      'GET',
      signal,
    );
    return this.parseState(state, dotId);
  }

  async ensure(
    dotId: string,
    signal?: AbortSignal,
  ): Promise<ComputerProviderState> {
    if (!validDotId(dotId))
      throw new Error(
        'Invalid Dot identifier for Cloudflare computer provider.',
      );
    const state = await this.request(
      `/__provider/computers/${encodeURIComponent(dotId)}/ensure`,
      'POST',
      signal,
    );
    const parsed = this.parseState(state, dotId);
    if (parsed.status !== 'running' || !parsed.endpoint) {
      throw new Error(
        'Cloudflare computer provider did not produce a running computer.',
      );
    }
    return parsed;
  }

  async stop(dotId: string, signal?: AbortSignal): Promise<void> {
    if (!validDotId(dotId))
      throw new Error(
        'Invalid Dot identifier for Cloudflare computer provider.',
      );
    const state = await this.request(
      `/__provider/computers/${encodeURIComponent(dotId)}/stop`,
      'POST',
      signal,
    );
    const parsed = this.parseState(state, dotId);
    if (parsed.status !== 'stopped') {
      throw new Error(
        'Cloudflare computer provider could not stop the Dot computer.',
      );
    }
  }
}
