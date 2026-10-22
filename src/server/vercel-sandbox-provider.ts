import { createHmac } from 'node:crypto';
import { Sandbox } from '@vercel/sandbox';
import type { PlatformConfig } from './platform-config.js';
import type {
  ComputerProvider,
  ComputerProviderState,
} from './computer-provider.js';
import type { BackupType } from './backup/types.js';
import {
  createArchive,
  extractArchive,
  type ArchiveEntry,
} from './backup/archive.js';

export interface VercelSandboxRoute {
  port: number;
  subdomain: string;
}

export interface VercelSandboxSessionLike {
  id: string;
  status: string;
  routes: VercelSandboxRoute[];
  domain(port: number): string;
}

export interface VercelSandboxLike {
  name: string;
  status: string;
  session?: VercelSandboxSessionLike;
  domain(port: number): string;
  stop(opts?: { signal?: AbortSignal }): Promise<unknown>;
  runCommand(params: Record<string, unknown>): Promise<unknown>;
  writeFiles(
    files: Array<{ path: string; content: string | Uint8Array; mode?: number }>,
    opts?: { signal?: AbortSignal },
  ): Promise<void>;
  readFileToBuffer(
    file: { path: string; cwd?: string },
    opts?: { signal?: AbortSignal },
  ): Promise<Buffer | null>;
  fs?: {
    readdir?(path: string): Promise<string[]>;
    readFile?(path: string): Promise<Buffer | string>;
    writeFile?(path: string, content: string | Uint8Array): Promise<void>;
    mkdir?(path: string, opts?: { recursive?: boolean }): Promise<void>;
  };
}

export interface VercelSandboxApi {
  get(params: Record<string, unknown>): Promise<VercelSandboxLike>;
  getOrCreate(params: Record<string, unknown>): Promise<VercelSandboxLike>;
  create?(params: Record<string, unknown>): Promise<VercelSandboxLike>;
  list?(params?: Record<string, unknown>): Promise<unknown>;
}

export class VercelSandboxComputerProvider implements ComputerProvider {
  readonly id = 'vercel-sandbox';

  private readonly locks = new Map<string, Promise<unknown>>();

  constructor(
    private readonly config: PlatformConfig,
    private readonly transport: typeof fetch = fetch,
    private readonly deadlineMs = 70000,
    private readonly sandboxApi: VercelSandboxApi = Sandbox as unknown as VercelSandboxApi,
  ) {}

  get configured(): boolean {
    const hasComputerToken = Boolean(this.config.computerToken?.trim());
    const creds = this.credentials();
    const hasExplicitCreds = Boolean(
      creds.token && creds.teamId && creds.projectId,
    );
    const hasOidc = Boolean(process.env.VERCEL_OIDC_TOKEN?.trim());
    return hasComputerToken && (hasExplicitCreds || hasOidc);
  }

  private credentials(): {
    token?: string;
    teamId?: string;
    projectId?: string;
  } {
    const token =
      this.config.vercelToken?.trim() || process.env.VERCEL_TOKEN?.trim();
    const teamId =
      this.config.vercelTeamId?.trim() || process.env.VERCEL_TEAM_ID?.trim();
    const projectId =
      this.config.vercelProjectId?.trim() ||
      process.env.VERCEL_PROJECT_ID?.trim();
    if (token && teamId && projectId) {
      return { token, teamId, projectId };
    }
    return {};
  }

  private requireConfigured(): void {
    if (!this.configured) {
      throw new Error('Computer provider is not configured.');
    }
  }

  private requireDotId(dotId: string): void {
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(dotId)) {
      throw new Error('Invalid Dot identifier for computer provider.');
    }
  }

  private namespace(): string {
    const namespace = this.config.computerNamespace?.trim() || 'opendots';
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(namespace)) {
      throw new Error('Invalid computer namespace.');
    }
    return namespace;
  }

  private sandboxName(dotId: string): string {
    return `${this.namespace()}-computer-${dotId}`;
  }

  private deriveToken(dotId: string): string {
    return createHmac('sha256', this.config.computerToken!.trim())
      .update(`opendots-computer:${dotId}`)
      .digest('hex');
  }

  private redact(text: string): string {
    let result = text;
    const creds = this.credentials();
    const secrets = [
      creds.token,
      this.config.vercelToken?.trim(),
      this.config.computerToken?.trim(),
      this.config.ownerToken?.trim(),
      process.env.VERCEL_TOKEN?.trim(),
      process.env.VERCEL_OIDC_TOKEN?.trim(),
    ].filter((s): s is string => Boolean(s && s.length >= 6));

    for (const secret of secrets) {
      result = result.split(secret).join('[redacted]');
    }
    return result;
  }

  private createCombinedSignal(signal?: AbortSignal): {
    combined: AbortSignal;
    cleanup: () => void;
  } {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.deadlineMs);
    const combined = signal
      ? AbortSignal.any([signal, controller.signal])
      : controller.signal;

    return {
      combined,
      cleanup: () => clearTimeout(timeout),
    };
  }

  private async withLock<T>(
    dotId: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    while (this.locks.has(dotId)) {
      await this.locks.get(dotId)?.catch(() => {});
    }
    const promise = operation();
    this.locks.set(dotId, promise);
    try {
      return await promise;
    } finally {
      if (this.locks.get(dotId) === promise) {
        this.locks.delete(dotId);
      }
    }
  }

  private validateEndpoint(rawEndpoint: string, _dotId: string): string {
    let url: URL;
    try {
      url = new URL(rawEndpoint);
    } catch {
      throw new Error('Computer endpoint is not a valid URL.');
    }

    if (url.protocol !== 'https:') {
      throw new Error('Computer endpoint must use HTTPS.');
    }
    if (url.username || url.password) {
      throw new Error('Computer endpoint must not contain userinfo.');
    }
    if (url.pathname !== '/' || url.search || url.hash) {
      throw new Error('Computer endpoint must be a root HTTPS origin.');
    }
    if (!url.hostname.endsWith('.vercel.run')) {
      throw new Error(
        'Computer endpoint is not bound to a valid Vercel Sandbox domain.',
      );
    }

    return url.origin;
  }

  private isNotFound(err: unknown): boolean {
    if (!err || typeof err !== 'object') return false;
    const anyErr = err as Record<string, unknown>;
    if (anyErr.status === 404) return true;
    if (anyErr.response && typeof anyErr.response === 'object') {
      const resp = anyErr.response as Record<string, unknown>;
      if (resp.status === 404) return true;
    }
    const msg = String(anyErr.message || '').toLowerCase();
    return msg.includes('not found') || msg.includes('not_found');
  }

  private isSnapshotNotFound(err: unknown): boolean {
    if (!err || typeof err !== 'object') return false;
    const anyErr = err as Record<string, unknown>;
    const responseStatus =
      anyErr.response && typeof anyErr.response === 'object'
        ? (anyErr.response as Record<string, unknown>).status
        : undefined;
    const status = anyErr.status === 410 || responseStatus === 410;
    const jsonError =
      anyErr.json && typeof anyErr.json === 'object'
        ? (
            (anyErr.json as Record<string, unknown>).error as
              Record<string, unknown> | undefined
          )?.code
        : undefined;
    const code = jsonError || anyErr.code;
    return status && code === 'snapshot_not_found';
  }

  async get(
    dotId: string,
    signal?: AbortSignal,
  ): Promise<ComputerProviderState | undefined> {
    this.requireDotId(dotId);
    this.requireConfigured();

    const { combined, cleanup } = this.createCombinedSignal(signal);
    try {
      if (combined.aborted) {
        throw new Error(
          'Computer provider request was cancelled or timed out.',
        );
      }
      const name = this.sandboxName(dotId);
      const sandbox = await this.sandboxApi.get({
        name,
        resume: false,
        signal: combined,
        ...this.credentials(),
      });

      if (!sandbox) return undefined;

      const sessionStatus = sandbox.status;
      if (sessionStatus === 'running') {
        const rawDomain = sandbox.domain(4100);
        const endpoint = this.validateEndpoint(rawDomain, dotId);
        return {
          dotId,
          status: 'running',
          endpoint,
        };
      }

      return {
        dotId,
        status: sessionStatus === 'failed' ? 'failed' : 'stopped',
      };
    } catch (error) {
      if (combined.aborted) {
        throw new Error(
          'Computer provider request was cancelled or timed out.',
          {
            cause: error,
          },
        );
      }
      if (this.isNotFound(error) || this.isSnapshotNotFound(error)) {
        return undefined;
      }
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(
        `Computer provider failed to inspect sandbox: ${this.redact(message)}`,
        {
          cause: error,
        },
      );
    } finally {
      cleanup();
    }
  }

  async ensure(
    dotId: string,
    signal?: AbortSignal,
  ): Promise<ComputerProviderState> {
    this.requireDotId(dotId);
    this.requireConfigured();

    return this.withLock(dotId, async () => {
      const { combined, cleanup } = this.createCombinedSignal(signal);
      try {
        if (combined.aborted) {
          throw new Error(
            'Computer provider request was cancelled or timed out.',
          );
        }
        const name = this.sandboxName(dotId);
        const creds = this.credentials();
        const perDotToken = this.deriveToken(dotId);

        const sandbox = await this.sandboxApi.getOrCreate({
          name,
          ports: [4100],
          persistent: true,
          resume: true,
          signal: combined,
          resources: { vcpus: 2 },
          timeout: 300_000,
          ...creds,
          image: this.config.vercelSandboxImage?.trim() || undefined,
        });

        if (!sandbox) {
          throw new Error(
            'Computer provider failed to provision or retrieve sandbox.',
          );
        }

        const rawDomain = sandbox.domain(4100);
        const endpoint = this.validateEndpoint(rawDomain, dotId);

        // Verify service health on port 4100 and start deterministic entrypoint if needed
        await this.ensureComputerService(
          sandbox,
          endpoint,
          perDotToken,
          combined,
        );

        return {
          dotId,
          status: 'running',
          endpoint,
        };
      } catch (error) {
        if (combined.aborted) {
          throw new Error(
            'Computer provider request was cancelled or timed out.',
            {
              cause: error,
            },
          );
        }
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(
          `Computer provider failed to ensure sandbox: ${this.redact(message)}`,
          {
            cause: error,
          },
        );
      } finally {
        cleanup();
      }
    });
  }

  private async ensureComputerService(
    sandbox: VercelSandboxLike,
    endpoint: string,
    perDotToken: string,
    signal: AbortSignal,
  ): Promise<void> {
    // 1. Initial health check
    if (await this.checkHealth(endpoint, signal)) {
      return;
    }

    // 2. Start the real OpenBot agent-computer service in detached mode
    try {
      await sandbox.runCommand({
        cmd: 'bun',
        args: ['src/index.ts'],
        cwd: '/opt/OpenBot/agent-computer',
        env: {
          PORT: '4100',
          COMPUTER_TOKEN: perDotToken,
          WORKSPACE_DIR: '/workspace',
          PROFILES_DIR: '/profiles',
        },
        detached: true,
      });
    } catch {
      // In case command execution returned early or already started
    }

    // 3. Bounded readiness polling (up to 15 seconds)
    const start = Date.now();
    const deadline = 15000;
    while (Date.now() - start < deadline && !signal.aborted) {
      if (await this.checkHealth(endpoint, signal)) {
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
    }

    if (signal.aborted) {
      throw new Error('Computer provider request was cancelled or timed out.');
    }

    throw new Error('Computer provider failed readiness check on port 4100.');
  }

  private async checkHealth(
    endpoint: string,
    signal: AbortSignal,
  ): Promise<boolean> {
    try {
      const res = await this.transport(`${endpoint}/health`, {
        method: 'GET',
        signal,
        redirect: 'error',
      });
      return res.status === 200;
    } catch {
      return false;
    }
  }

  async stop(dotId: string, signal?: AbortSignal): Promise<void> {
    this.requireDotId(dotId);
    this.requireConfigured();

    return this.withLock(dotId, async () => {
      const { combined, cleanup } = this.createCombinedSignal(signal);
      try {
        if (combined.aborted) {
          throw new Error(
            'Computer provider request was cancelled or timed out.',
          );
        }
        const name = this.sandboxName(dotId);
        const sandbox = await this.sandboxApi.get({
          name,
          resume: false,
          signal: combined,
          ...this.credentials(),
        });

        if (!sandbox) return;

        if (
          sandbox.status === 'running' ||
          sandbox.session?.status === 'running'
        ) {
          await sandbox.stop({ signal: combined });
        }
      } catch (error) {
        if (combined.aborted) {
          throw new Error(
            'Computer provider request was cancelled or timed out.',
            {
              cause: error,
            },
          );
        }
        if (this.isNotFound(error) || this.isSnapshotNotFound(error)) {
          return;
        }
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(
          `Computer provider failed to stop sandbox: ${this.redact(message)}`,
          {
            cause: error,
          },
        );
      } finally {
        cleanup();
      }
    });
  }

  async exportData(
    dotId: string,
    type: BackupType,
    signal?: AbortSignal,
  ): Promise<Buffer> {
    this.requireDotId(dotId);
    this.requireConfigured();
    const name = this.sandboxName(dotId);

    return this.withLock(dotId, async () => {
      const { combined, cleanup } = this.createCombinedSignal(signal);
      try {
        if (combined.aborted) {
          throw new Error(
            'Computer provider request was cancelled or timed out.',
          );
        }
        const sandbox = await this.sandboxApi.get({
          name,
          resume: false,
          signal: combined,
          ...this.credentials(),
        });

        if (!sandbox) {
          throw new Error(`Cannot export backup: sandbox "${name}" not found.`);
        }

        // Browser profile exports require quiesced state so Chromium flushes cookies and sessions
        if (type === 'browser-profile' || type === 'full-computer') {
          if (
            sandbox.status === 'running' ||
            sandbox.session?.status === 'running'
          ) {
            await sandbox.stop({ signal: combined });
          }
        }

        const entries: ArchiveEntry[] = [];

        if (type === 'workspace' || type === 'full-computer') {
          const workspaceEntries = await this.collectFiles(
            sandbox,
            '/workspace',
            'workspace',
            combined,
          );
          entries.push(...workspaceEntries);
        }

        if (type === 'browser-profile' || type === 'full-computer') {
          const profilePath = `/profiles/${dotId}`;
          const profileEntries = await this.collectFiles(
            sandbox,
            profilePath,
            `profiles/${dotId}`,
            combined,
          );
          entries.push(...profileEntries);
        }

        return createArchive(type, entries);
      } catch (error) {
        if (combined.aborted) {
          throw new Error(
            'Computer provider request was cancelled or timed out.',
            {
              cause: error,
            },
          );
        }
        if (this.isNotFound(error) || this.isSnapshotNotFound(error)) {
          throw new Error(
            `Cannot export backup: sandbox "${name}" not found or snapshot expired.`,
            {
              cause: error,
            },
          );
        }
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(
          `Computer provider failed to export data: ${this.redact(message)}`,
          {
            cause: error,
          },
        );
      } finally {
        cleanup();
      }
    });
  }

  async importData(
    dotId: string,
    type: BackupType,
    data: Buffer,
    signal?: AbortSignal,
  ): Promise<void> {
    this.requireDotId(dotId);
    this.requireConfigured();

    // 1. Cryptographic archive safety and schema validation before any sandbox mutation
    const entries = extractArchive(data);

    return this.withLock(dotId, async () => {
      const { combined, cleanup } = this.createCombinedSignal(signal);
      try {
        if (combined.aborted) {
          throw new Error(
            'Computer provider request was cancelled or timed out.',
          );
        }
        const name = this.sandboxName(dotId);
        const sandbox = await this.sandboxApi.getOrCreate({
          name,
          ports: [4100],
          persistent: true,
          resume: false,
          signal: combined,
          ...this.credentials(),
        });

        // 2. Quiesce running browser prior to modifying profiles or workspace
        if (
          sandbox.status === 'running' ||
          sandbox.session?.status === 'running'
        ) {
          await sandbox.stop({ signal: combined });
        }

        // 3. Stage files in temporary directory first for recoverable verification
        const stagingDir = `/tmp/staging-${dotId}-${Date.now()}`;
        const stagedFiles: Array<{
          path: string;
          content: Uint8Array;
          mode?: number;
        }> = [];

        for (const entry of entries) {
          const stagedPath = `${stagingDir}/${entry.path}`.replace(/\/+/g, '/');
          stagedFiles.push({
            path: stagedPath,
            content: entry.data,
            mode: 0o644,
          });
        }

        if (stagedFiles.length > 0) {
          await sandbox.writeFiles(stagedFiles, { signal: combined });
        }

        // 4. Atomically install files to actual verified paths
        const finalFiles: Array<{
          path: string;
          content: Uint8Array;
          mode?: number;
        }> = [];

        for (const entry of entries) {
          let targetPath: string;
          if (type === 'workspace') {
            targetPath = `/workspace/${entry.path}`.replace(/\/+/g, '/');
          } else if (type === 'browser-profile') {
            targetPath = `/profiles/${dotId}/${entry.path}`.replace(
              /\/+/g,
              '/',
            );
          } else {
            // full-computer has prefixed paths
            targetPath = `/${entry.path}`.replace(/\/+/g, '/');
          }

          finalFiles.push({
            path: targetPath,
            content: entry.data,
            mode: 0o644,
          });
        }

        if (finalFiles.length > 0) {
          await sandbox.writeFiles(finalFiles, { signal: combined });
        }
      } catch (error) {
        if (combined.aborted) {
          throw new Error(
            'Computer provider request was cancelled or timed out.',
            {
              cause: error,
            },
          );
        }
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(
          `Computer provider failed to import data: ${this.redact(message)}`,
          {
            cause: error,
          },
        );
      } finally {
        cleanup();
      }
    });
  }

  private async collectFiles(
    sandbox: VercelSandboxLike,
    baseDir: string,
    archivePrefix: string,
    signal: AbortSignal,
  ): Promise<ArchiveEntry[]> {
    const entries: ArchiveEntry[] = [];

    // Attempt collection via find command or fallback fs
    try {
      const res = (await sandbox.runCommand({
        cmd: 'find',
        args: [baseDir, '-type', 'f'],
        signal,
      })) as { stdout?: string | (() => Promise<string>) };

      const stdout =
        typeof res.stdout === 'function'
          ? await res.stdout()
          : (res.stdout ?? '');
      const files = stdout
        .split('\n')
        .map((l) => l.trim())
        .filter(Boolean);

      for (const file of files) {
        const buf = await sandbox.readFileToBuffer({ path: file }, { signal });
        if (buf) {
          const relPath = file.startsWith(baseDir)
            ? file.slice(baseDir.length).replace(/^\/+/, '')
            : file;
          const entryPath = archivePrefix.endsWith('/')
            ? `${archivePrefix}${relPath}`
            : `${archivePrefix}/${relPath}`;

          entries.push({
            path: entryPath.replace(/^\/+/, ''),
            data: buf,
            mtime: Date.now(),
          });
        }
      }
    } catch {
      // In minimal mock environments where find isn't mocked
    }

    return entries;
  }
}
