import { afterEach, describe, expect, it, vi } from 'vitest';
import { WorkspaceStore } from '../src/server/workspace.js';
import { ComputerService } from '../src/server/computer-service.js';
import { computerRoutes } from '../src/server/computer-routes.js';
import { BackupService } from '../src/server/backup/backup-service.js';
import { createArchive, extractArchive } from '../src/server/backup/archive.js';
import type {
  StorageAdapter,
  BackupMetadata,
  BackupType,
} from '../src/server/backup/types.js';
import type { ComputerProvider } from '../src/server/computer-provider.js';

class MemoryStorageAdapter implements StorageAdapter {
  private readonly objects = new Map<
    string,
    { body: Buffer; metadata?: Record<string, string> }
  >();

  async writeBackup(
    key: string,
    data: Buffer,
    metadata?: Record<string, string>,
  ): Promise<{ key: string }> {
    this.objects.set(key, { body: Buffer.from(data), metadata });
    return { key };
  }

  async readBackup(
    key: string,
  ): Promise<{ data: Buffer; metadata?: Record<string, string> }> {
    const item = this.objects.get(key);
    if (!item) throw new Error(`Backup not found: ${key}`);
    return { data: Buffer.from(item.body), metadata: item.metadata };
  }

  async hasBackup(key: string): Promise<boolean> {
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

  async deleteBackup(key: string): Promise<void> {
    this.objects.delete(key);
  }

  async listBackups(
    prefix?: string,
  ): Promise<Array<{ key: string; size: number; lastModified: Date }>> {
    const results: Array<{ key: string; size: number; lastModified: Date }> =
      [];
    for (const [key, item] of this.objects.entries()) {
      if (!prefix || key.startsWith(prefix)) {
        results.push({
          key,
          size: item.body.length,
          lastModified: new Date(),
        });
      }
    }
    return results;
  }
}

const stores: WorkspaceStore[] = [];

afterEach(() => {
  for (const s of stores.splice(0)) s.close();
});

const TEST_KEY = Buffer.from(
  '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
  'hex',
);

function createTestHarness() {
  const workspace = new WorkspaceStore(':memory:', 'owner');
  stores.push(workspace);

  const dots = workspace.dots();
  const dotA = dots[0].id;
  const defaultSpace =
    workspace.spaces()[0]?.id ?? workspace.createSpace('Default', '').id;
  const dotB = workspace.createDot(defaultSpace, 'Dot B', '', true, true).id;

  const storage = new MemoryStorageAdapter();
  const backupService = new BackupService(storage, TEST_KEY);

  // Virtual in-memory computer state per Dot
  const computerFiles = new Map<string, Map<string, string>>();
  computerFiles.set(dotA, new Map());
  computerFiles.set(dotB, new Map());

  const computerRunning = new Map<string, boolean>();
  computerRunning.set(dotA, true);
  computerRunning.set(dotB, true);

  const lifecycleLog: string[] = [];

  const mockProvider: ComputerProvider = {
    id: 'docker-supervisor',
    get configured() {
      return true;
    },
    async get(dotId) {
      return {
        dotId,
        status: computerRunning.get(dotId) ? 'running' : 'stopped',
        endpoint: `http://127.0.0.1:4100`,
      };
    },
    async ensure(dotId) {
      lifecycleLog.push(`ensure:${dotId}`);
      computerRunning.set(dotId, true);
      return {
        dotId,
        status: 'running',
        endpoint: `http://127.0.0.1:4100`,
      };
    },
    async stop(dotId) {
      lifecycleLog.push(`stop:${dotId}`);
      computerRunning.set(dotId, false);
    },
    async exportData(dotId, type) {
      lifecycleLog.push(`exportData:${dotId}:${type}`);
      if (type === 'workspace') {
        const files = computerFiles.get(dotId) ?? new Map();
        return createArchive(
          'workspace',
          Array.from(files.entries()).map(([path, content]) => ({
            path,
            data: Buffer.from(content, 'utf8'),
          })),
        );
      }
      if (type === 'browser-profile') {
        return createArchive('browser-profile', [
          {
            path: 'Default/Cookies',
            data: Buffer.from('test-session-cookie-data', 'utf8'),
          },
          {
            path: 'Default/Preferences',
            data: Buffer.from('{"browser":{"theme":"dark"}}', 'utf8'),
          },
        ]);
      }
      if (type === 'full-computer') {
        const files = computerFiles.get(dotId) ?? new Map();
        return createArchive(
          'full-computer',
          Array.from(files.entries()).map(([path, content]) => ({
            path: `workspace/${path}`,
            data: Buffer.from(content, 'utf8'),
          })),
        );
      }
      throw new Error(`Provider does not handle ${type}`);
    },
    async importData(dotId, type, data) {
      lifecycleLog.push(`importData:${dotId}:${type}`);
      const entries = extractArchive(data);
      if (type === 'workspace' || type === 'full-computer') {
        const files = computerFiles.get(dotId) ?? new Map<string, string>();
        files.clear();
        for (const entry of entries) {
          if (type === 'workspace') files.set(entry.path, entry.data.toString('utf8'));
          else if (entry.path.startsWith('workspace/')) {
            files.set(entry.path.slice('workspace/'.length), entry.data.toString('utf8'));
          }
        }
        computerFiles.set(dotId, files);
      }
      return;
    },
  };

  const transport: typeof fetch = async (input, init) => {
    const url = String(input);
    const headers = new Headers(init?.headers);
    const dotId = headers.get('x-openbot-bot-id') ?? dotA;
    const body = init?.body ? JSON.parse(String(init.body)) : {};

    if (url.endsWith('/control')) {
      return Response.json({
        holder: 'human',
        requested: false,
        transitioning: false,
        resumeSnapshotRequired: false,
        request: { id: 'req-1', status: 'taken' },
      });
    }

    if (url.endsWith('/files/list')) {
      const filesMap = computerFiles.get(dotId) ?? new Map();
      const entries = Array.from(filesMap.entries()).map(
        ([filePath, content]) => ({
          path: filePath,
          kind: 'file' as const,
          bytes: Buffer.byteLength(content, 'utf8'),
        }),
      );
      return Response.json({ path: '', entries, truncated: false });
    }

    if (url.endsWith('/files/read')) {
      const filesMap = computerFiles.get(dotId) ?? new Map();
      const content = filesMap.get(body.path) ?? '';
      return Response.json({
        path: body.path,
        text: content,
        truncated: false,
        bytes: Buffer.byteLength(content, 'utf8'),
      });
    }

    if (url.endsWith('/files/write')) {
      const filesMap = computerFiles.get(dotId) ?? new Map();
      filesMap.set(body.path, body.contents ?? '');
      return Response.json({
        path: body.path,
        bytes: Buffer.byteLength(body.contents ?? '', 'utf8'),
        appended: false,
      });
    }

    return Response.json({});
  };

  const config = {
    baseUrl: 'https://example.com',
    voiceName: 'voice',
    slackUsers: [],
    runtimeUrl: 'http://localhost',
    computerToken: 'master-token-for-testing-12345678',
  };

  const service = new ComputerService(
    workspace,
    config,
    () => false,
    transport,
    5000,
    mockProvider,
    backupService,
  );

  workspace.computers.patch(dotA, {
    enabled: true,
    browser: true,
    files: true,
    shell: true,
  });
  workspace.computers.patch(dotB, {
    enabled: true,
    browser: true,
    files: true,
    shell: true,
  });

  return {
    workspace,
    dotA,
    dotB,
    storage,
    backupService,
    service,
    mockProvider,
    computerFiles,
    computerRunning,
    lifecycleLog,
  };
}

describe('B2 Computer Backup & Restore Integration', () => {
  it('exports actual workspace files, encrypts to B2, and restores verified files to the same Dot', async () => {
    const { service, dotA, computerFiles, storage } = createTestHarness();

    // 1. Create actual files in the virtual workspace
    const filesA = computerFiles.get(dotA)!;
    filesA.set('notes.txt', 'Important project notes.');
    filesA.set('data/config.json', '{"version": 1, "active": true}');

    // 2. Take a workspace backup snapshot
    const envelope = await service.snapshot(dotA, 'workspace');
    expect(envelope.dotId).toBe(dotA);
    expect(envelope.backupType).toBe('workspace');
    expect(envelope.backupId).toBeDefined();

    // 3. Verify B2 storage received an encrypted envelope (ODBK binary header)
    const storedKeys = await storage.listBackups(`backups/${dotA}/workspace/`);
    expect(storedKeys).toHaveLength(1);
    const rawUploaded = (await storage.readBackup(storedKeys[0].key)).data;
    expect(rawUploaded.subarray(0, 4).toString('utf8')).toBe('ODBK');
    // Ensure raw plaintext is NOT present in ciphertext
    expect(rawUploaded.includes(Buffer.from('Important project notes.'))).toBe(
      false,
    );

    // 4. Simulate computer file loss / corruption
    filesA.clear();
    expect(filesA.size).toBe(0);

    // 5. Restore the snapshot
    const restoreResult = await service.restore(
      dotA,
      envelope.backupId,
      'workspace',
    );
    expect(restoreResult.restored).toBe(true);
    expect(restoreResult.backupId).toBe(envelope.backupId);

    // 6. Verify exact files and contents were written back to the computer
    expect(filesA.get('notes.txt')).toBe('Important project notes.');
    expect(filesA.get('data/config.json')).toBe(
      '{"version": 1, "active": true}',
    );
  });

  it('enforces quiescent state during Chromium browser-profile capture (stops then resumes)', async () => {
    const { service, dotA, lifecycleLog, computerRunning } =
      createTestHarness();

    // Computer starts running
    expect(computerRunning.get(dotA)).toBe(true);
    lifecycleLog.length = 0;

    // Snapshot browser profile
    const envelope = await service.snapshot(dotA, 'browser-profile');
    expect(envelope.backupType).toBe('browser-profile');

    // Verify quiescent sequence: stop -> exportData -> ensure
    expect(lifecycleLog).toEqual([
      `stop:${dotA}`,
      `exportData:${dotA}:browser-profile`,
      `ensure:${dotA}`,
    ]);

    // Computer was resumed and is still running
    expect(computerRunning.get(dotA)).toBe(true);
  });

  it('keeps workspace and browser-profile backups isolated by type', async () => {
    const { service, dotA, computerFiles } = createTestHarness();

    computerFiles.get(dotA)!.set('workspace.txt', 'workspace data');

    // Create both types of backups
    const wsEnvelope = await service.snapshot(dotA, 'workspace');
    const bpEnvelope = await service.snapshot(dotA, 'browser-profile');

    // Listing by type filters strictly
    const wsList = await service.listBackups(dotA, 'workspace');
    expect(wsList).toHaveLength(1);
    expect(wsList[0].backupId).toBe(wsEnvelope.backupId);

    const bpList = await service.listBackups(dotA, 'browser-profile');
    expect(bpList).toHaveLength(1);
    expect(bpList[0].backupId).toBe(bpEnvelope.backupId);

    const allList = await service.listBackups(dotA);
    expect(allList).toHaveLength(2);
  });

  it('enforces strict cross-Dot isolation: one Dot cannot restore another Dots backup', async () => {
    const { service, dotA, dotB } = createTestHarness();

    const dotABackup = await service.snapshot(dotA, 'browser-profile');

    // Dot B listing does not include Dot A's backup
    const dotBList = await service.listBackups(dotB);
    expect(dotBList).toHaveLength(0);

    // Dot B attempting to restore Dot A's backup fails
    await expect(
      service.restore(dotB, dotABackup.backupId, 'browser-profile'),
    ).rejects.toThrow();
  });

  it('surfaces computer resume failures cleanly if container fails to restart after backup', async () => {
    const { service, dotA, mockProvider } = createTestHarness();

    // Force provider.ensure to fail after backup
    mockProvider.ensure = vi
      .fn()
      .mockRejectedValue(new Error('Daemon OOM killed container'));

    await expect(service.snapshot(dotA, 'browser-profile')).rejects.toThrow(
      /failed to resume computer: Daemon OOM killed container/,
    );
  });

  it('does not destroy working computer state if restore encounters corrupt or malicious archive', async () => {
    const { service, dotA, backupService, computerFiles } = createTestHarness();

    // Working state before restore
    computerFiles
      .get(dotA)!
      .set('production.txt', 'working data that must not be deleted');

    // Create a malicious backup with path traversal
    const maliciousArchive = createArchive('workspace', [
      {
        path: '../../../etc/shadow',
        data: Buffer.from('malicious payload'),
      },
    ]);

    const maliciousEnvelope = await backupService.createBackup({
      dotId: dotA,
      backupType: 'workspace',
      plaintext: maliciousArchive,
    });

    // Attempt restore
    await expect(
      service.restore(dotA, maliciousEnvelope.backupId, 'workspace'),
    ).rejects.toThrow(/Path traversal escape detected/);

    // Verify existing state was NOT wiped
    expect(computerFiles.get(dotA)!.get('production.txt')).toBe(
      'working data that must not be deleted',
    );
  });

  it('fails safely when wrong encryption key is used without altering computer', async () => {
    const { service, dotA, storage, computerFiles } = createTestHarness();

    computerFiles.get(dotA)!.set('file.txt', 'original');
    const envelope = await service.snapshot(dotA, 'workspace');

    // Create a rogue service with a different key
    const WRONG_KEY = Buffer.from(
      'ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff',
      'hex',
    );
    const wrongBackupService = new BackupService(storage, WRONG_KEY);
    const rogueService = new ComputerService(
      service['workspace'],
      service['config'],
      () => false,
      fetch,
      5000,
      service['provider'],
      wrongBackupService,
    );

    // Restore with wrong key fails cryptographic verification
    await expect(
      rogueService.restore(dotA, envelope.backupId, 'workspace'),
    ).rejects.toThrow(/Backup decryption\/authentication failed/);

    expect(computerFiles.get(dotA)!.get('file.txt')).toBe('original');
  });

  describe('Authenticated HTTP API Routes', () => {
    it('serves list, snapshot, and restore through computerRoutes with owner authorization and Dot isolation', async () => {
      const { service, dotA, dotB, computerFiles } = createTestHarness();
      const routes = computerRoutes(service);

      // 1. Initial listing is empty
      const listRes1 = await routes.request(
        `http://localhost/dots/${dotA}/computer/backups`,
      );
      expect(listRes1.status).toBe(200);
      const listJson1 = (await listRes1.json()) as { backups: unknown[] };
      expect(listJson1.backups).toHaveLength(0);

      // 2. Snapshot via POST /dots/:id/computer/backups
      computerFiles.get(dotA)!.set('hello.txt', 'world');
      const snapRes = await routes.request(
        `http://localhost/dots/${dotA}/computer/backups`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ type: 'workspace' }),
        },
      );
      expect(snapRes.status).toBe(201);
      const snapJson = (await snapRes.json()) as {
        backup: { backupId: string };
      };
      expect(snapJson.backup.backupId).toBeDefined();

      // 3. Listing now includes the backup
      const listRes2 = await routes.request(
        `http://localhost/dots/${dotA}/computer/backups`,
      );
      const listJson2 = (await listRes2.json()) as {
        backups: Array<{ backupId: string }>;
      };
      expect(listJson2.backups).toHaveLength(1);
      expect(listJson2.backups[0].backupId).toBe(snapJson.backup.backupId);

      // 4. Dot B cannot see Dot A's backups
      const listResB = await routes.request(
        `http://localhost/dots/${dotB}/computer/backups`,
      );
      const listJsonB = (await listResB.json()) as { backups: unknown[] };
      expect(listJsonB.backups).toHaveLength(0);

      // 5. Restore via POST /dots/:id/computer/backups/:backupId/restore
      computerFiles.get(dotA)!.clear();
      const restoreRes = await routes.request(
        `http://localhost/dots/${dotA}/computer/backups/${snapJson.backup.backupId}/restore`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ type: 'workspace' }),
        },
      );
      expect(restoreRes.status).toBe(200);
      const restoreJson = (await restoreRes.json()) as { restored: boolean };
      expect(restoreJson.restored).toBe(true);
      expect(computerFiles.get(dotA)!.get('hello.txt')).toBe('world');

      // 6. Dot B cannot restore Dot A's backup
      const rogueRestore = await routes.request(
        `http://localhost/dots/${dotB}/computer/backups/${snapJson.backup.backupId}/restore`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ type: 'workspace' }),
        },
      );
      expect(rogueRestore.status).toBe(404);

      // 7. Non-existent Dot returns 404
      const nonExistent = await routes.request(
        `http://localhost/dots/non-existent-dot-id/computer/backups`,
      );
      expect(nonExistent.status).toBe(404);
    });
  });
});
