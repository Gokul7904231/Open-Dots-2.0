import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PlatformConfig } from '../src/server/platform-config.js';
import { createComputerProvider } from '../src/server/computer-provider-factory.js';
import {
  VercelSandboxComputerProvider,
  type VercelSandboxApi,
  type VercelSandboxLike,
} from '../src/server/vercel-sandbox-provider.js';
import { extractArchive } from '../src/server/backup/archive.js';
import { BackupService } from '../src/server/backup/backup-service.js';
import type {
  StorageAdapter,
  BackupMetadata,
  BackupType,
} from '../src/server/backup/types.js';

const MASTER_TOKEN = 'test-master-token-longer-than-24-chars-abc123';
const VERCEL_TOKEN = 'test-vercel-token-secret-12345';
const VERCEL_TEAM = 'team_123456';
const VERCEL_PROJECT = 'prj_123456';

function testConfig(overrides: Partial<PlatformConfig> = {}): PlatformConfig {
  return {
    baseUrl: 'https://example.com',
    voiceName: 'voice',
    slackUsers: [],
    runtimeUrl: 'http://localhost',
    computerToken: MASTER_TOKEN,
    vercelToken: VERCEL_TOKEN,
    vercelTeamId: VERCEL_TEAM,
    vercelProjectId: VERCEL_PROJECT,
    computerNamespace: 'opendots',
    ...overrides,
  };
}

class FakeSandbox implements VercelSandboxLike {
  public files = new Map<string, Buffer>();
  public commandsRun: Array<Record<string, unknown>> = [];
  public stopCount = 0;

  constructor(
    public name: string,
    public status: 'running' | 'stopped' | 'failed' = 'running',
    public domainHost = 'subdomain-1.vercel.run',
  ) {}

  get session() {
    return {
      id: `sess_${this.name}`,
      status: this.status,
      routes: [
        { port: 4100, subdomain: this.domainHost.replace('.vercel.run', '') },
      ],
      domain: (port: number) => {
        if (port !== 4100) throw new Error(`No route for port ${port}`);
        return `https://${this.domainHost}`;
      },
    };
  }

  domain(port: number): string {
    return this.session.domain(port);
  }

  async stop(_opts?: { signal?: AbortSignal }) {
    this.stopCount++;
    this.status = 'stopped';
    return { snapshot: { snapshotId: `snap_${this.name}` } };
  }

  async runCommand(params: Record<string, unknown>) {
    this.commandsRun.push(params);
    const cmd = String(params.cmd || '');
    if (cmd === 'find') {
      const baseDir = String((params.args as string[])?.[0] || '');
      const matching: string[] = [];
      for (const [filePath] of this.files.entries()) {
        if (filePath.startsWith(baseDir)) {
          matching.push(filePath);
        }
      }
      return {
        stdout: () => Promise.resolve(matching.join('\n')),
      };
    }
    return { exitCode: 0, stdout: () => Promise.resolve('') };
  }

  async writeFiles(
    files: Array<{ path: string; content: string | Uint8Array; mode?: number }>,
    _opts?: { signal?: AbortSignal },
  ): Promise<void> {
    for (const f of files) {
      this.files.set(f.path, Buffer.from(f.content));
    }
  }

  async readFileToBuffer(
    file: { path: string; cwd?: string },
    _opts?: { signal?: AbortSignal },
  ): Promise<Buffer | null> {
    return this.files.get(file.path) ?? null;
  }
}

class FakeSandboxApi implements VercelSandboxApi {
  public sandboxes = new Map<string, FakeSandbox>();
  public getCount = 0;
  public getOrCreateCount = 0;

  async get(params: Record<string, unknown>): Promise<VercelSandboxLike> {
    this.getCount++;
    const name = String(params.name || '');
    const sb = this.sandboxes.get(name);
    if (!sb) {
      const err = new Error(`Sandbox not found: ${name}`);
      (err as unknown as Record<string, unknown>).status = 404;
      throw err;
    }
    return sb;
  }

  async getOrCreate(
    params: Record<string, unknown>,
  ): Promise<VercelSandboxLike> {
    this.getOrCreateCount++;
    const name = String(params.name || '');
    let sb = this.sandboxes.get(name);
    if (!sb) {
      sb = new FakeSandbox(name, 'running');
      this.sandboxes.set(name, sb);
    } else if (params.resume) {
      sb.status = 'running';
    }
    return sb;
  }
}

class MemoryStorageAdapter implements StorageAdapter {
  private readonly objects = new Map<
    string,
    { body: Buffer; metadata?: Record<string, string> }
  >();

  async writeBackup(
    key: string,
    data: Buffer,
    metadata?: Record<string, string>,
  ) {
    this.objects.set(key, { body: Buffer.from(data), metadata });
    return { key };
  }

  async readBackup(key: string) {
    const item = this.objects.get(key);
    if (!item) throw new Error(`Backup not found: ${key}`);
    return { data: Buffer.from(item.body), metadata: item.metadata };
  }

  async hasBackup(key: string) {
    return this.objects.has(key);
  }

  async getMetadata(key: string): Promise<BackupMetadata | null> {
    const item = this.objects.get(key);
    if (!item) return null;
    return {
      key,
      dotId: item.metadata?.dotId ?? '',
      backupId: item.metadata?.backupId ?? '',
      backupType: (item.metadata?.backupType as BackupType) ?? 'workspace',
      byteLength: item.body.length,
      createdAt: Number(item.metadata?.createdAt ?? Date.now()),
    };
  }

  async deleteBackup(key: string) {
    this.objects.delete(key);
  }

  async listBackups(prefix?: string) {
    const res: Array<{ key: string; size: number; lastModified: Date }> = [];
    for (const [key, item] of this.objects.entries()) {
      if (!prefix || key.startsWith(prefix)) {
        res.push({ key, size: item.body.length, lastModified: new Date() });
      }
    }
    return res;
  }
}

const TEST_BACKUP_KEY = Buffer.from(
  '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
  'hex',
);

afterEach(() => {
  vi.restoreAllMocks();
});

describe('VercelSandboxComputerProvider', () => {
  it('registers in factory for vercel-sandbox and vercel aliases', () => {
    const p1 = createComputerProvider(
      testConfig({ computerProvider: 'vercel-sandbox' }),
    );
    expect(p1.id).toBe('vercel-sandbox');
    expect(p1).toBeInstanceOf(VercelSandboxComputerProvider);

    const p2 = createComputerProvider(
      testConfig({ computerProvider: 'vercel' }),
    );
    expect(p2.id).toBe('vercel-sandbox');
    expect(p2).toBeInstanceOf(VercelSandboxComputerProvider);

    expect(() =>
      createComputerProvider(
        testConfig({ computerProvider: 'unsupported-provider' }),
      ),
    ).toThrow(/Unsupported COMPUTER_PROVIDER/);
  });

  it('determines configured status based on credentials and master computer token', () => {
    const api = new FakeSandboxApi();
    const readyProvider = new VercelSandboxComputerProvider(
      testConfig(),
      fetch,
      5000,
      api,
    );
    expect(readyProvider.configured).toBe(true);

    const missingToken = new VercelSandboxComputerProvider(
      testConfig({ computerToken: '' }),
      fetch,
      5000,
      api,
    );
    expect(missingToken.configured).toBe(false);

    const missingVercelCreds = new VercelSandboxComputerProvider(
      testConfig({ vercelToken: undefined }),
      fetch,
      5000,
      api,
    );
    expect(missingVercelCreds.configured).toBe(false);
  });

  it('enforces stable per-Dot naming and rejects invalid Dot IDs', async () => {
    const api = new FakeSandboxApi();
    const provider = new VercelSandboxComputerProvider(
      testConfig(),
      fetch,
      5000,
      api,
    );

    await expect(provider.get('../traversal')).rejects.toThrow(
      /Invalid Dot identifier/,
    );
    await expect(provider.get('dot/123')).rejects.toThrow(
      /Invalid Dot identifier/,
    );
    await expect(provider.get('   ')).rejects.toThrow(/Invalid Dot identifier/);
    await expect(provider.ensure('invalid!id')).rejects.toThrow(
      /Invalid Dot identifier/,
    );
  });

  it('inspects state with get() without creating or waking a sandbox', async () => {
    const api = new FakeSandboxApi();
    const provider = new VercelSandboxComputerProvider(
      testConfig(),
      fetch,
      5000,
      api,
    );

    // 1. Non-existent sandbox returns undefined
    const missing = await provider.get('dot-missing');
    expect(missing).toBeUndefined();
    expect(api.getOrCreateCount).toBe(0);

    // 2. Stopped sandbox returns stopped status without waking
    const stoppedSb = new FakeSandbox(
      'opendots-computer-dot-stopped',
      'stopped',
    );
    api.sandboxes.set('opendots-computer-dot-stopped', stoppedSb);

    const stoppedState = await provider.get('dot-stopped');
    expect(stoppedState).toEqual({
      dotId: 'dot-stopped',
      status: 'stopped',
    });
    expect(stoppedSb.status).toBe('stopped');
    expect(api.getOrCreateCount).toBe(0);

    // 3. Running sandbox returns running status with validated endpoint
    const runningSb = new FakeSandbox(
      'opendots-computer-dot-running',
      'running',
      'agent-1.vercel.run',
    );
    api.sandboxes.set('opendots-computer-dot-running', runningSb);

    const runningState = await provider.get('dot-running');
    expect(runningState).toEqual({
      dotId: 'dot-running',
      status: 'running',
      endpoint: 'https://agent-1.vercel.run',
    });
  });

  it('ensures computer idempotently and safely handles concurrent calls', async () => {
    const api = new FakeSandboxApi();
    const transport: typeof fetch = async (url) => {
      if (String(url).endsWith('/health')) {
        return new Response(JSON.stringify({ status: 'healthy' }), {
          status: 200,
        });
      }
      return new Response('Not found', { status: 404 });
    };

    const provider = new VercelSandboxComputerProvider(
      testConfig(),
      transport,
      5000,
      api,
    );

    // Concurrent ensure() for the same Dot
    const [res1, res2] = await Promise.all([
      provider.ensure('dot-concurrent'),
      provider.ensure('dot-concurrent'),
    ]);

    expect(res1.status).toBe('running');
    expect(res1.endpoint).toBe('https://subdomain-1.vercel.run');
    expect(res2).toEqual(res1);

    // Only one sandbox created in API
    expect(api.sandboxes.has('opendots-computer-dot-concurrent')).toBe(true);
  });

  it('starts the agent-computer service and verifies readiness when health is initially offline', async () => {
    const api = new FakeSandboxApi();
    let healthAttempts = 0;
    const transport: typeof fetch = async (url) => {
      if (String(url).endsWith('/health')) {
        healthAttempts++;
        if (healthAttempts >= 2) {
          return new Response(JSON.stringify({ ok: true }), { status: 200 });
        }
        return new Response('Offline', { status: 503 });
      }
      return new Response('Not found', { status: 404 });
    };

    const provider = new VercelSandboxComputerProvider(
      testConfig(),
      transport,
      5000,
      api,
    );
    const state = await provider.ensure('dot-boot');

    expect(state.status).toBe('running');
    const sb = api.sandboxes.get('opendots-computer-dot-boot');
    expect(sb).toBeDefined();
    expect(sb!.commandsRun.length).toBeGreaterThan(0);
    expect(sb!.commandsRun[0].cmd).toBe('bun');
    expect((sb!.commandsRun[0].env as Record<string, string>).PORT).toBe(
      '4100',
    );
  });

  it('stops compute non-destructively without deleting files', async () => {
    const api = new FakeSandboxApi();
    const provider = new VercelSandboxComputerProvider(
      testConfig(),
      fetch,
      5000,
      api,
    );

    const sb = new FakeSandbox('opendots-computer-dot-persist', 'running');
    sb.files.set('/workspace/notes.txt', Buffer.from('hello world'));
    api.sandboxes.set('opendots-computer-dot-persist', sb);

    await provider.stop('dot-persist');
    expect(sb.status).toBe('stopped');
    expect(sb.stopCount).toBe(1);
    expect(sb.files.get('/workspace/notes.txt')?.toString()).toBe(
      'hello world',
    );
  });

  it('strictly validates endpoint origin, scheme, and rejection of foreign domains', async () => {
    const api = new FakeSandboxApi();

    // Insecure HTTP
    const sbHttp = new FakeSandbox(
      'opendots-computer-dot-insecure',
      'running',
      'agent.vercel.run',
    );
    sbHttp.domain = () => 'http://agent.vercel.run';
    api.sandboxes.set('opendots-computer-dot-insecure', sbHttp);

    const provider = new VercelSandboxComputerProvider(
      testConfig(),
      fetch,
      5000,
      api,
    );
    await expect(provider.get('dot-insecure')).rejects.toThrow(
      /must use HTTPS/,
    );

    // Foreign domain
    const sbForeign = new FakeSandbox(
      'opendots-computer-dot-foreign',
      'running',
      'evil.attacker.com',
    );
    sbForeign.domain = () => 'https://evil.attacker.com';
    api.sandboxes.set('opendots-computer-dot-foreign', sbForeign);

    await expect(provider.get('dot-foreign')).rejects.toThrow(
      /bound to a valid Vercel Sandbox domain/,
    );

    // Non-root path
    const sbPath = new FakeSandbox(
      'opendots-computer-dot-path',
      'running',
      'sub.vercel.run',
    );
    sbPath.domain = () => 'https://sub.vercel.run/unexpected/path';
    api.sandboxes.set('opendots-computer-dot-path', sbPath);

    await expect(provider.get('dot-path')).rejects.toThrow(
      /must be a root HTTPS origin/,
    );
  });

  it('redacts sensitive credentials from errors', async () => {
    const api = new FakeSandboxApi();
    api.get = async () => {
      throw new Error(
        `Auth failed with token ${VERCEL_TOKEN} and master ${MASTER_TOKEN}`,
      );
    };

    const provider = new VercelSandboxComputerProvider(
      testConfig(),
      fetch,
      5000,
      api,
    );
    try {
      await provider.get('dot-redact');
      expect.fail('Should have thrown error');
    } catch (err: unknown) {
      const msg = (err as Error).message;
      expect(msg).not.toContain(VERCEL_TOKEN);
      expect(msg).not.toContain(MASTER_TOKEN);
      expect(msg).toContain('[redacted]');
    }
  });

  it('exports and imports workspace and browser-profile backups with quiescence and staging', async () => {
    const api = new FakeSandboxApi();
    const provider = new VercelSandboxComputerProvider(
      testConfig(),
      fetch,
      5000,
      api,
    );

    const sb = new FakeSandbox('opendots-computer-dot-backup', 'running');
    sb.files.set(
      '/workspace/code/main.ts',
      Buffer.from('console.log("hello");'),
    );
    sb.files.set(
      '/profiles/dot-backup/Cookies',
      Buffer.from('fake-cookie-data'),
    );
    api.sandboxes.set('opendots-computer-dot-backup', sb);

    // 1. Export workspace
    const workspaceArchiveBuffer = await provider.exportData(
      'dot-backup',
      'workspace',
    );
    expect(workspaceArchiveBuffer).toBeInstanceOf(Buffer);
    const extractedWorkspace = extractArchive(workspaceArchiveBuffer);
    expect(
      extractedWorkspace.some((e) => e.path === 'workspace/code/main.ts'),
    ).toBe(true);

    // 2. Export browser-profile (triggers quiescence!)
    const profileArchiveBuffer = await provider.exportData(
      'dot-backup',
      'browser-profile',
    );
    expect(sb.stopCount).toBeGreaterThanOrEqual(1); // Browser was quiesced
    const extractedProfile = extractArchive(profileArchiveBuffer);
    expect(
      extractedProfile.some((e) => e.path === 'profiles/dot-backup/Cookies'),
    ).toBe(true);

    // 3. Import into a fresh Dot computer
    const targetDot = 'dot-target';
    const targetSb = new FakeSandbox(
      `opendots-computer-${targetDot}`,
      'stopped',
    );
    api.sandboxes.set(`opendots-computer-${targetDot}`, targetSb);

    await provider.importData(targetDot, 'workspace', workspaceArchiveBuffer);
    expect(
      targetSb.files.get('/workspace/workspace/code/main.ts') ||
        targetSb.files.get('/workspace/code/main.ts'),
    ).toBeDefined();
  });

  it('integrates seamlessly with the authenticated B2 BackupService', async () => {
    const api = new FakeSandboxApi();
    const provider = new VercelSandboxComputerProvider(
      testConfig(),
      fetch,
      5000,
      api,
    );

    const storage = new MemoryStorageAdapter();
    const backupService = new BackupService(storage, TEST_BACKUP_KEY);

    const dotId = 'dot-b2';
    const sb = new FakeSandbox(`opendots-computer-${dotId}`, 'stopped');
    sb.files.set('/workspace/project.json', Buffer.from('{"version":"2.0"}'));
    api.sandboxes.set(`opendots-computer-${dotId}`, sb);

    // 1. Export data through provider
    const plaintextBuffer = await provider.exportData(dotId, 'workspace');

    // 2. Create authenticated encrypted B2 backup
    const backupResult = await backupService.createBackup({
      dotId,
      backupType: 'workspace',
      plaintext: plaintextBuffer,
    });

    expect(backupResult.backupId).toBeDefined();
    const expectedKey = `backups/${dotId}/workspace/${backupResult.backupId}.odbackup`;
    expect(await storage.hasBackup(expectedKey)).toBe(true);

    // 3. Restore and cryptographically verify through B2 BackupService
    const restored = await backupService.restoreBackup(
      dotId,
      backupResult.backupId,
      'workspace',
    );
    expect(restored.envelope.dotId).toBe(dotId);
    expect(restored.plaintext).toEqual(plaintextBuffer);

    // 4. Import verified plaintext back into target sandbox
    await provider.importData(dotId, 'workspace', restored.plaintext);
    expect(
      sb.files.has('/workspace/workspace/project.json') ||
        sb.files.has('/workspace/project.json'),
    ).toBe(true);
  });

  it('handles cancellation and abort signals correctly', async () => {
    const api = new FakeSandboxApi();
    const provider = new VercelSandboxComputerProvider(
      testConfig(),
      fetch,
      5000,
      api,
    );

    const controller = new AbortController();
    controller.abort();

    await expect(
      provider.ensure('dot-aborted', controller.signal),
    ).rejects.toThrow(/cancelled or timed out/);
    await expect(
      provider.get('dot-aborted', controller.signal),
    ).rejects.toThrow(/cancelled or timed out/);
  });

  it('handles snapshot expiration and missing sandbox failures gracefully', async () => {
    const api = new FakeSandboxApi();
    api.get = async () => {
      const err = new Error('Snapshot expired');
      (err as unknown as Record<string, unknown>).status = 410;
      (err as unknown as Record<string, unknown>).code = 'snapshot_not_found';
      throw err;
    };

    const provider = new VercelSandboxComputerProvider(
      testConfig(),
      fetch,
      5000,
      api,
    );

    // get() on expired snapshot returns undefined without crashing
    const state = await provider.get('dot-expired');
    expect(state).toBeUndefined();

    // exportData on missing sandbox fails loudly without returning empty data
    await expect(
      provider.exportData('dot-expired', 'workspace'),
    ).rejects.toThrow(/Cannot export backup.*not found/);
  });
});
