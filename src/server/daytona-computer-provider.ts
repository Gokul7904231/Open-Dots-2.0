import { createHash, createHmac } from 'node:crypto';
import type { PlatformConfig } from './platform-config.js';
import type {
  ComputerProvider,
  ComputerProviderState,
} from './computer-provider.js';
import { DAYTONA_COMPUTER_DOCKERFILE } from './daytona-computer-image.js';

type JsonObject = Record<string, unknown>;

type DaytonaSandbox = {
  id: string;
  name?: string;
  state?: string;
  status?: string;
  labels?: Record<string, string>;
};

type DaytonaPreview = {
  url: string;
};

function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function nestedSandbox(value: unknown): DaytonaSandbox {
  const candidate =
    isObject(value) && isObject(value.sandbox) ? value.sandbox : value;
  if (!isObject(candidate))
    throw new Error('Daytona returned an invalid sandbox response.');
  const id = typeof candidate.id === 'string' ? candidate.id : '';
  const name = typeof candidate.name === 'string' ? candidate.name : undefined;
  const state =
    typeof candidate.state === 'string'
      ? candidate.state
      : typeof candidate.status === 'string'
        ? candidate.status
        : '';
  const labels = isObject(candidate.labels)
    ? Object.fromEntries(
        Object.entries(candidate.labels).filter(
          (entry): entry is [string, string] => typeof entry[1] === 'string',
        ),
      )
    : undefined;
  if (!id || !state)
    throw new Error(
      'Daytona sandbox response is missing its id or lifecycle state.',
    );
  return { id, name, state, labels };
}

function lifecycle(state: string): ComputerProviderState['status'] {
  switch (state.trim().toLowerCase()) {
    case 'started':
    case 'running':
      return 'running';
    case 'starting':
    case 'stopping':
    case 'creating':
    case 'building':
      return 'starting';
    case 'stopped':
    case 'archived':
    case 'paused':
      return 'stopped';
    default:
      return 'failed';
  }
}

function numberInRange(
  value: number | undefined,
  fallback: number,
  min: number,
  max: number,
): number {
  const chosen = value ?? fallback;
  if (!Number.isInteger(chosen) || chosen < min || chosen > max)
    throw new Error(
      `Daytona resource setting must be an integer from ${min} to ${max}.`,
    );
  return chosen;
}

/**
 * Experimental Daytona adapter.
 *
 * Daytona owns the sandbox lifecycle and its persistent disk. The private,
 * port-scoped signed preview URL is short-lived and refreshed for each lookup;
 * the broad sandbox preview token is never stored or forwarded.
 */
export class DaytonaComputerProvider implements ComputerProvider {
  readonly id = 'daytona';

  constructor(
    private readonly config: PlatformConfig,
    private readonly transport: typeof fetch = fetch,
    private readonly requestTimeoutMs = 15000,
  ) {}

  get configured() {
    return (
      !!this.config.daytonaApiKey?.trim() && !!this.config.computerToken?.trim()
    );
  }

  private apiBase() {
    const base = (this.config.daytonaApiBaseUrl || 'https://app.daytona.io/api')
      .trim()
      .replace(/\/+$/, '');
    const url = new URL(base);
    if (
      url.protocol !== 'https:' &&
      url.hostname !== 'localhost' &&
      url.hostname !== '127.0.0.1'
    )
      throw new Error('Daytona API URL must use HTTPS.');
    return url.toString().replace(/\/$/, '');
  }

  private toolboxBase() {
    const base = (
      this.config.daytonaToolboxBaseUrl ||
      'https://proxy.app.daytona.io/toolbox'
    )
      .trim()
      .replace(/\/+$/, '');
    const url = new URL(base);
    if (
      url.protocol !== 'https:' &&
      url.hostname !== 'localhost' &&
      url.hostname !== '127.0.0.1'
    )
      throw new Error('Daytona toolbox URL must use HTTPS.');
    return url.toString().replace(/\/$/, '');
  }

  private namespace() {
    const value = (this.config.daytonaComputerNamespace || 'opendots').trim();
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,39}$/.test(value))
      throw new Error(
        'DAYTONA_COMPUTER_NAMESPACE must contain 1–40 letters, digits, underscores or hyphens.',
      );
    return value;
  }

  private dotName(dotId: string) {
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(dotId))
      throw new Error('Invalid Dot identifier for Daytona.');
    const digest = createHash('sha256')
      .update(`${this.namespace()}:${dotId}`)
      .digest('hex')
      .slice(0, 24);
    return `od-${digest}`;
  }

  private async jsonRequest(
    url: string,
    init: RequestInit = {},
    timeoutMs = this.requestTimeoutMs,
    allowNotFound = false,
  ): Promise<unknown | undefined> {
    if (!this.configured)
      throw new Error('Daytona provider is not configured.');
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const headers = new Headers(init.headers);
      headers.set(
        'Authorization',
        `Bearer ${this.config.daytonaApiKey!.trim()}`,
      );
      headers.set('Accept', 'application/json');
      if (init.body) headers.set('Content-Type', 'application/json');
      const response = await this.transport(url, {
        ...init,
        redirect: 'error',
        headers,
        signal: controller.signal,
      });
      if (allowNotFound && response.status === 404) return undefined;
      if (!response.ok)
        throw new Error(`Daytona request failed with HTTP ${response.status}.`);
      if (!response.body)
        throw new Error('Daytona returned an empty response.');
      const reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let size = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.length;
        if (size > 1_000_000) {
          await reader.cancel();
          throw new Error('Daytona response exceeded its size limit.');
        }
        chunks.push(value);
      }
      const text = Buffer.concat(chunks).toString('utf8');
      try {
        return JSON.parse(text) as unknown;
      } catch {
        throw new Error('Daytona returned malformed JSON.');
      }
    } catch (error) {
      if (controller.signal.aborted)
        throw new Error('Daytona request timed out.', { cause: error });
      if (
        error instanceof Error &&
        /^Daytona (request failed|returned|response exceeded)/.test(
          error.message,
        )
      )
        throw error;
      throw new Error(
        'Daytona is unavailable or returned an invalid response.',
        { cause: error },
      );
    } finally {
      clearTimeout(timeout);
    }
  }

  private async api(
    path: string,
    init: RequestInit = {},
    timeoutMs = this.requestTimeoutMs,
    allowNotFound = false,
  ) {
    return this.jsonRequest(
      `${this.apiBase()}${path}`,
      init,
      timeoutMs,
      allowNotFound,
    );
  }

  private assertOwned(
    sandbox: DaytonaSandbox,
    expectedName: string,
    dotId: string,
  ) {
    if (sandbox.name && sandbox.name !== expectedName)
      throw new Error('Daytona sandbox name does not match this Dot.');
    const namespaceLabel = sandbox.labels?.['opendots-namespace'];
    const dotLabel = sandbox.labels?.['opendots-dot-id'];
    if (
      (namespaceLabel && namespaceLabel !== this.namespace()) ||
      (dotLabel && dotLabel !== dotId)
    )
      throw new Error(
        'Daytona sandbox ownership labels do not match this Dot.',
      );
  }

  private async findSandbox(
    dotId: string,
  ): Promise<DaytonaSandbox | undefined> {
    const name = this.dotName(dotId);
    const value = await this.api(
      `/sandbox/${encodeURIComponent(name)}`,
      {},
      this.requestTimeoutMs,
      true,
    );
    if (value === undefined) return undefined;
    const sandbox = nestedSandbox(value);
    this.assertOwned(sandbox, name, dotId);
    return sandbox;
  }

  private async signedPreview(sandboxId: string): Promise<DaytonaPreview> {
    const value = await this.api(
      `/sandbox/${encodeURIComponent(sandboxId)}/ports/4100/signed-preview-url?expiresInSeconds=3600`,
    );
    if (!isObject(value) || typeof value.url !== 'string')
      throw new Error('Daytona did not return a signed computer preview URL.');
    const url = new URL(value.url);
    if (
      url.protocol !== 'https:' ||
      url.username ||
      url.password ||
      url.pathname !== '/' ||
      url.search ||
      url.hash
    )
      throw new Error('Daytona returned an invalid signed preview URL.');
    return { url: url.origin };
  }

  private async isHealthy(endpoint: string): Promise<boolean> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);
    try {
      const response = await this.transport(
        new URL('/health', endpoint).toString(),
        {
          method: 'GET',
          redirect: 'error',
          signal: controller.signal,
        },
      );
      return response.ok;
    } catch {
      return false;
    } finally {
      clearTimeout(timeout);
    }
  }

  async get(
    dotId: string,
    _signal?: AbortSignal,
  ): Promise<ComputerProviderState | undefined> {
    const sandbox = await this.findSandbox(dotId);
    if (!sandbox) return undefined;
    const status = lifecycle(sandbox.state || '');
    if (status !== 'running') return { dotId, status };
    try {
      const preview = await this.signedPreview(sandbox.id);
      if (!(await this.isHealthy(preview.url)))
        return { dotId, status: 'starting' };
      return { dotId, status: 'running', endpoint: preview.url };
    } catch {
      return { dotId, status: 'starting' };
    }
  }

  private async createSandbox(dotId: string): Promise<DaytonaSandbox> {
    const name = this.dotName(dotId);
    const cpu = numberInRange(this.config.daytonaComputerCpu, 1, 1, 8);
    const memory = numberInRange(
      this.config.daytonaComputerMemoryGiB,
      2,
      2,
      32,
    );
    const disk = numberInRange(this.config.daytonaComputerDiskGiB, 8, 5, 100);
    const body = {
      name,
      buildInfo: { dockerfileContent: DAYTONA_COMPUTER_DOCKERFILE },
      cpu,
      memory,
      disk,
      public: false,
      autoStopInterval: 0,
      autoArchiveInterval: 0,
      autoDeleteInterval: 0,
      labels: {
        'opendots-namespace': this.namespace(),
        'opendots-dot-id': dotId,
        'opendots-managed': 'true',
      },
    };
    try {
      const value = await this.api(
        '/sandbox',
        {
          method: 'POST',
          body: JSON.stringify(body),
        },
        15 * 60 * 1000,
      );
      const sandbox = nestedSandbox(value);
      this.assertOwned(sandbox, name, dotId);
      return sandbox;
    } catch (error) {
      // A concurrent ensure may have won the deterministic-name creation race.
      const existing = await this.findSandbox(dotId).catch(() => undefined);
      if (existing) return existing;
      throw error;
    }
  }

  private computerToken(dotId: string) {
    return createHmac('sha256', this.config.computerToken!.trim())
      .update(`opendots-computer:${dotId}`)
      .digest('hex');
  }

  private async launchComputer(sandboxId: string, dotId: string) {
    const command = `if ! bun -e 'const r = await fetch("http://127.0.0.1:4100/health").catch(() => null); process.exit(r?.ok ? 0 : 1)'; then nohup bun src/index.ts >/tmp/opendots-computer.log 2>&1 </dev/null & fi`;
    const env = {
      COMPUTER_TOKEN: this.computerToken(dotId),
      COMPUTER_BOT_ID: dotId,
      COMPUTER_BROWSER_MODE: 'headless',
      COMPUTER_BROWSER_BACKEND: 'managed',
      WORKSPACE_DIR: '/workspace',
      PROFILES_DIR: '/profiles',
      PORT: '4100',
    };
    const value = await this.jsonRequest(
      `${this.toolboxBase()}/${encodeURIComponent(sandboxId)}/process/execute`,
      {
        method: 'POST',
        body: JSON.stringify({
          command,
          cwd: '/opt/OpenBot/agent-computer',
          env,
          timeout: 30,
        }),
      },
      40000,
    );
    if (
      isObject(value) &&
      typeof value.exitCode === 'number' &&
      value.exitCode !== 0
    )
      throw new Error('Daytona failed to start the Dot computer process.');
  }

  async ensure(
    dotId: string,
    signal?: AbortSignal,
  ): Promise<ComputerProviderState> {
    signal?.throwIfAborted();
    let sandbox = await this.findSandbox(dotId);
    if (!sandbox) sandbox = await this.createSandbox(dotId);
    signal?.throwIfAborted();

    if (lifecycle(sandbox.state || '') !== 'running') {
      await this.api(
        `/sandbox/${encodeURIComponent(sandbox.id)}/start`,
        { method: 'POST' },
        120000,
      );
    }

    // If the service is already healthy, don't accidentally launch a second browser server.
    const existing = await this.get(dotId);
    if (existing?.status === 'running' && existing.endpoint) return existing;

    await this.launchComputer(sandbox.id, dotId);
    for (let attempt = 0; attempt < 30; attempt++) {
      signal?.throwIfAborted();
      const state = await this.get(dotId);
      if (state?.status === 'running' && state.endpoint) return state;
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
    throw new Error(
      'Daytona sandbox started, but the Dot computer did not pass its health check. Inspect the sandbox process logs before retrying.',
    );
  }

  async stop(dotId: string, signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    const sandbox = await this.findSandbox(dotId);
    if (!sandbox) return;
    await this.api(`/sandbox/${encodeURIComponent(sandbox.id)}/stop`, {
      method: 'POST',
    });
  }
}
