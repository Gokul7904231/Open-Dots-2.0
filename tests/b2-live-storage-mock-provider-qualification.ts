/**
 * Live B2 Storage Qualification with a Mock Computer Provider
 *
 * Uses the live Backblaze B2 bucket for object operations, but a mocked computer provider and an in-memory virtual filesystem
 * Validates B2 encryption/upload/download/cleanup through the OpenDots API while simulating computer filesystem and lifecycle behavior; this is NOT Docker or real-computer qualification.
 */

import { randomUUID, randomBytes } from 'node:crypto';
import { WorkspaceStore } from '../src/server/workspace.js';
import { ComputerService } from '../src/server/computer-service.js';
import { createApp } from '../src/server/app.js';
import { Store } from '../src/server/store.js';
import { Runner } from '../src/server/runner.js';
import {
  b2ConfigFromEnv,
  B2StorageAdapter,
  BackupService,
  createArchive,
  extractArchive,
} from '../src/server/backup/index.js';
import type { ComputerProvider } from '../src/server/computer-provider.js';
import type { Platform } from '../src/server/platform.js';

async function main() {
  console.log(
    '================================================================',
  );
  console.log('LIVE B2 STORAGE + MOCK COMPUTER PROVIDER QUALIFICATION');
  console.log(
    '================================================================',
  );

  // 1. Verify B2 Configuration
  const b2Config = b2ConfigFromEnv(process.env);
  if (!b2Config) {
    throw new Error('Backblaze B2 credentials not configured in environment.');
  }

  console.log(`[B2 Config] Endpoint : ${b2Config.endpoint}`);
  console.log(`[B2 Config] Region   : ${b2Config.region}`);
  console.log(`[B2 Config] Bucket   : ${b2Config.bucket}`);
  console.log(
    `[B2 Config] Key ID   : ...${b2Config.keyId.slice(-4)} (redacted)`,
  );

  const storage = new B2StorageAdapter(b2Config);
  const encryptionKey = randomBytes(32); // 256-bit AES key
  const backupService = new BackupService(storage, encryptionKey);

  // 2. Setup Real Workspace with Disposable Dot
  const workspace = new WorkspaceStore(':memory:', 'owner');
  const space = workspace.createSpace('E2E Space', 'Live Qualification');
  const testDot = workspace.createDot(
    space.id,
    'E2E Test Dot',
    'E2E qualification dot',
    true,
    true,
  );
  const testDotId = testDot.id;
  workspace.computers.patch(testDotId, {
    enabled: true,
    browser: true,
    files: true,
    shell: true,
  });

  const rogueDot = workspace.createDot(
    space.id,
    'E2E Rogue Dot',
    'Rogue cross-dot test',
    true,
    true,
  );
  const rogueDotId = rogueDot.id;
  workspace.computers.patch(rogueDotId, {
    enabled: true,
    browser: true,
    files: true,
    shell: true,
  });

  console.log(`[Setup] Created disposable test Dot: ${testDotId}`);
  console.log(`[Setup] Created rogue test Dot     : ${rogueDotId}`);

  // 3. Virtual Computer Filesystem & Lifecycle State for this Disposable Dot
  const virtualFiles = new Map<string, string>();
  let computerRunning = true;
  const lifecycleEvents: string[] = [];

  const mockProvider: ComputerProvider = {
    id: 'docker-supervisor',
    get configured() {
      return true;
    },
    async get(dotId) {
      return {
        dotId,
        status: computerRunning ? 'running' : 'stopped',
        endpoint: 'http://127.0.0.1:4100',
      };
    },
    async ensure(dotId) {
      lifecycleEvents.push(`ensure:${dotId}`);
      computerRunning = true;
      return { dotId, status: 'running', endpoint: 'http://127.0.0.1:4100' };
    },
    async stop(dotId) {
      lifecycleEvents.push(`stop:${dotId}`);
      computerRunning = false;
    },
    async exportData(dotId, type) {
      lifecycleEvents.push(`exportData:${dotId}:${type}`);
      if (type === 'workspace') {
        return createArchive(
          'workspace',
          Array.from(virtualFiles.entries()).map(([path, content]) => ({
            path,
            data: Buffer.from(content, 'utf8'),
          })),
        );
      }
      if (type === 'browser-profile') {
        return createArchive('browser-profile', [
          {
            path: 'Default/Cookies',
            data: Buffer.from(
              'test-auth-session-cookie=mock-only-value',
              'utf8',
            ),
          },
        ]);
      }
      if (type === 'full-computer') {
        return createArchive(
          'full-computer',
          Array.from(virtualFiles.entries()).map(([path, content]) => ({
            path: `workspace/${path}`,
            data: Buffer.from(content, 'utf8'),
          })),
        );
      }
      throw new Error(`Provider does not handle ${type}`);
    },
    async importData(dotId, type, data) {
      lifecycleEvents.push(`importData:${dotId}:${type}`);
      const entries = extractArchive(data);
      if (type === 'workspace' || type === 'full-computer') {
        virtualFiles.clear();
        for (const entry of entries) {
          if (type === 'workspace') virtualFiles.set(entry.path, entry.data.toString('utf8'));
          else if (entry.path.startsWith('workspace/')) {
            virtualFiles.set(entry.path.slice('workspace/'.length), entry.data.toString('utf8'));
          }
        }
      }
    },
  };

  const transport: typeof fetch = async (input, init) => {
    const url = String(input);
    const body = init?.body ? JSON.parse(String(init.body)) : {};

    if (url.endsWith('/control')) {
      return Response.json({
        holder: 'human',
        requested: false,
        transitioning: false,
        resumeSnapshotRequired: false,
        request: { id: 'req-e2e', status: 'taken' },
      });
    }

    if (url.endsWith('/files/list')) {
      const entries = Array.from(virtualFiles.entries()).map(
        ([filePath, content]) => ({
          path: filePath,
          kind: 'file' as const,
          bytes: Buffer.byteLength(content, 'utf8'),
        }),
      );
      return Response.json({ path: '', entries, truncated: false });
    }

    if (url.endsWith('/files/read')) {
      const content = virtualFiles.get(body.path);
      if (content === undefined) {
        return Response.json(
          { error: `File not found: ${body.path}` },
          { status: 404 },
        );
      }
      return Response.json({
        path: body.path,
        text: content,
        truncated: false,
        bytes: Buffer.byteLength(content, 'utf8'),
      });
    }

    if (url.endsWith('/files/write')) {
      virtualFiles.set(body.path, body.contents ?? '');
      return Response.json({
        path: body.path,
        bytes: Buffer.byteLength(body.contents ?? '', 'utf8'),
        appended: false,
      });
    }

    return Response.json({});
  };

  const OWNER_TOKEN = 'TEST_ONLY_OWNER_TOKEN_NOT_A_SECRET_20261022';
  const platformConfig = {
    baseUrl: 'http://localhost:3000',
    voiceName: 'voice',
    slackUsers: [],
    runtimeUrl: 'http://localhost',
    computerToken: 'TEST_ONLY_COMPUTER_TOKEN_NOT_A_SECRET',
  };

  const computerService = new ComputerService(
    workspace,
    platformConfig,
    () => false,
    transport,
    10000,
    mockProvider,
    backupService,
  );

  // Setup full platform and authenticated app
  const appStore = new Store(':memory:');
  const appRunner = new Runner(appStore, {
    mode: 'sample',
    baseUrl: 'https://api.openai.com/v1',
  });
  const platform = {
    workspace,
    computers: computerService,
    connections: { store: { list: () => [] } },
    setup: () => ({ missing: [] }),
  } as unknown as Platform;

  const app = createApp({
    store: appStore,
    runner: appRunner,
    config: { mode: 'sample', baseUrl: 'https://api.openai.com/v1' },
    ownerToken: OWNER_TOKEN,
    platform,
  });

  const headers = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${OWNER_TOKEN}`,
  };

  let uploadedBackupKey: string | null = null;

  try {
    // -------------------------------------------------------------
    // Test 1: Authenticated API access check
    // -------------------------------------------------------------
    console.log('\n--- Step 1: Testing API Authentication ---');
    const unauthRes = await app.request(
      `/api/dots/${testDotId}/computer/backups`,
    );
    if (unauthRes.status !== 401) {
      throw new Error(
        `Expected 401 for missing token, got ${unauthRes.status}`,
      );
    }
    console.log('PASS: Missing owner token returns 401 Unauthorized.');

    const wrongTokenRes = await app.request(
      `/api/dots/${testDotId}/computer/backups`,
      {
        headers: { Authorization: 'Bearer wrong-token' },
      },
    );
    if (wrongTokenRes.status !== 401) {
      throw new Error(
        `Expected 401 for wrong token, got ${wrongTokenRes.status}`,
      );
    }
    console.log('PASS: Incorrect owner token returns 401 Unauthorized.');

    const authRes = await app.request(
      `/api/dots/${testDotId}/computer/backups`,
      { headers },
    );
    if (authRes.status !== 200) {
      throw new Error(`Expected 200 for valid token, got ${authRes.status}`);
    }
    console.log('PASS: Valid owner token returns 200 OK.');

    // -------------------------------------------------------------
    // Test 2: Create Marker File in Workspace
    // -------------------------------------------------------------
    console.log('\n--- Step 2: Creating Marker File in Workspace ---');
    const markerFileName = 'e2e-b2-marker.txt';
    const markerContent = `OpenDots B2 E2E Marker Test | Timestamp: ${new Date().toISOString()} | Nonce: ${randomUUID()}`;
    virtualFiles.set(markerFileName, markerContent);
    console.log(`[Marker] File: ${markerFileName}`);
    console.log(`[Marker] Content: "${markerContent}"`);

    // -------------------------------------------------------------
    // Test 3: Create B2 Workspace Backup through OpenDots API
    // -------------------------------------------------------------
    console.log(
      '\n--- Step 3: Triggering B2 Backup via POST /api/dots/:id/computer/backups ---',
    );
    const backupRes = await app.request(
      `/api/dots/${testDotId}/computer/backups`,
      {
        method: 'POST',
        headers,
        body: JSON.stringify({ type: 'workspace' }),
      },
    );

    if (backupRes.status !== 201) {
      const errText = await backupRes.text();
      throw new Error(
        `Backup API failed with HTTP ${backupRes.status}: ${errText}`,
      );
    }

    const backupJson = (await backupRes.json()) as {
      backup: { backupId: string; dotId: string };
    };
    const backupId = backupJson.backup.backupId;
    console.log(
      `PASS: B2 Backup created successfully via API. Backup ID: ${backupId}`,
    );

    // -------------------------------------------------------------
    // Test 4: Verify Encrypted Object in Real Backblaze B2 Bucket
    // -------------------------------------------------------------
    console.log('\n--- Step 4: Verifying Object Directly in Backblaze B2 ---');
    uploadedBackupKey = `backups/${testDotId}/workspace/${backupId}.odbackup`;
    const b2Exists = await storage.hasBackup(uploadedBackupKey);
    if (!b2Exists) {
      throw new Error(
        `Object key ${uploadedBackupKey} not found in Backblaze B2 bucket.`,
      );
    }
    console.log(
      `PASS: Object confirmed present in Backblaze B2 bucket: ${uploadedBackupKey}`,
    );

    const rawDownloaded = await storage.readBackup(uploadedBackupKey);
    const magic = rawDownloaded.data.subarray(0, 4).toString('utf8');
    if (magic !== 'ODBK') {
      throw new Error(`Invalid magic header in B2 object: ${magic}`);
    }
    console.log(
      `PASS: Binary envelope verified: magic='${magic}', total bytes=${rawDownloaded.data.length}`,
    );

    // Check that plaintext marker does not leak into ciphertext
    if (rawDownloaded.data.includes(Buffer.from(markerContent))) {
      throw new Error(
        'SECURITY VIOLATION: Plaintext marker content found in uploaded B2 ciphertext!',
      );
    }
    console.log('PASS: Ciphertext does not leak plaintext marker content.');

    // -------------------------------------------------------------
    // Test 5: Delete Marker from Computer (Simulate Data Loss)
    // -------------------------------------------------------------
    console.log('\n--- Step 5: Deleting Marker from Computer ---');
    virtualFiles.delete(markerFileName);
    if (virtualFiles.has(markerFileName)) {
      throw new Error('Failed to delete marker file.');
    }
    console.log('PASS: Marker successfully deleted from computer filesystem.');

    // -------------------------------------------------------------
    // Test 6: Restore Backup through OpenDots API
    // -------------------------------------------------------------
    console.log(
      '\n--- Step 6: Triggering Restore via POST /api/dots/:id/computer/backups/:backupId/restore ---',
    );
    const restoreRes = await app.request(
      `/api/dots/${testDotId}/computer/backups/${backupId}/restore`,
      {
        method: 'POST',
        headers,
        body: JSON.stringify({ type: 'workspace' }),
      },
    );

    if (restoreRes.status !== 200) {
      const errText = await restoreRes.text();
      throw new Error(
        `Restore API failed with HTTP ${restoreRes.status}: ${errText}`,
      );
    }

    const restoreJson = (await restoreRes.json()) as {
      restored: boolean;
      backupId: string;
    };
    if (!restoreJson.restored) {
      throw new Error('Restore response reported restored=false.');
    }
    console.log('PASS: Restore completed successfully via OpenDots API.');

    // -------------------------------------------------------------
    // Test 7: Verify Exact Marker Recovery
    // -------------------------------------------------------------
    console.log('\n--- Step 7: Verifying Recovered Marker Content ---');
    const recoveredContent = virtualFiles.get(markerFileName);
    if (recoveredContent === undefined) {
      throw new Error('Marker file was not restored into virtual filesystem.');
    }
    if (recoveredContent !== markerContent) {
      throw new Error(
        `Content mismatch! Expected "${markerContent}", got "${recoveredContent}"`,
      );
    }
    console.log(`PASS: Exact marker content recovered byte-for-byte!`);
    console.log(`[Recovered]: "${recoveredContent}"`);

    // -------------------------------------------------------------
    // Test 8: Browser-Profile Backup & Restore Quiescence Lifecycle
    // -------------------------------------------------------------
    console.log(
      '\n--- Step 8: Testing Browser-Profile Quiescence Lifecycle ---',
    );
    lifecycleEvents.length = 0;
    computerRunning = true;

    const bpBackupRes = await app.request(
      `/api/dots/${testDotId}/computer/backups`,
      {
        method: 'POST',
        headers,
        body: JSON.stringify({ type: 'browser-profile' }),
      },
    );

    if (bpBackupRes.status !== 201) {
      throw new Error(
        `Browser profile backup failed: ${await bpBackupRes.text()}`,
      );
    }

    const bpBackupId = (
      (await bpBackupRes.json()) as { backup: { backupId: string } }
    ).backup.backupId;
    const bpBackupKey = `backups/${testDotId}/browser-profile/${bpBackupId}.odbackup`;

    // Verify quiescent sequence: stop container -> export profile -> ensure resume
    console.log(`[Lifecycle Events]: ${JSON.stringify(lifecycleEvents)}`);
    if (
      lifecycleEvents[0] !== `stop:${testDotId}` ||
      lifecycleEvents[1] !== `exportData:${testDotId}:browser-profile` ||
      lifecycleEvents[2] !== `ensure:${testDotId}`
    ) {
      throw new Error(
        `Invalid quiescence sequence: ${JSON.stringify(lifecycleEvents)}`,
      );
    }
    console.log(
      'PASS: Chromium container was stopped, profile captured quiescently, and resumed.',
    );

    // Clean up bp backup from B2
    await storage.deleteBackup(bpBackupKey);
    console.log('PASS: Temporary browser-profile backup cleaned up from B2.');

    // -------------------------------------------------------------
    // Test 9: Cross-Dot Isolation & Unauthorized Cross-Dot Restore
    // -------------------------------------------------------------
    console.log('\n--- Step 9: Testing Cross-Dot Isolation ---');
    // Rogue Dot listing must NOT include test Dot's backups
    const rogueListRes = await app.request(
      `/api/dots/${rogueDotId}/computer/backups`,
      { headers },
    );
    const rogueListJson = (await rogueListRes.json()) as { backups: unknown[] };
    if (rogueListJson.backups.length !== 0) {
      throw new Error(
        `Isolation breach: Rogue Dot could list Test Dot backups!`,
      );
    }
    console.log('PASS: Rogue Dot cannot see Test Dot backups in listing.');

    // Rogue Dot attempting to restore Test Dot's backupId must fail (404)
    const rogueRestoreRes = await app.request(
      `/api/dots/${rogueDotId}/computer/backups/${backupId}/restore`,
      {
        method: 'POST',
        headers,
        body: JSON.stringify({ type: 'workspace' }),
      },
    );
    if (rogueRestoreRes.status !== 404) {
      throw new Error(
        `Expected 404 for cross-Dot restore, got ${rogueRestoreRes.status}`,
      );
    }
    console.log(
      'PASS: Rogue Dot cannot restore Test Dot backup (404 Not Found).',
    );

    console.log(
      '\n================================================================',
    );
    console.log('B2 STORAGE + MOCK COMPUTER PROVIDER TESTS PASSED. THIS IS NOT REAL DOCKER E2E QUALIFICATION.');
    console.log(
      '================================================================',
    );
  } finally {
    // -------------------------------------------------------------
    // Cleanup Live B2 Object
    // -------------------------------------------------------------
    if (uploadedBackupKey) {
      console.log(
        `\n[Cleanup] Deleting temporary test object from Backblaze B2: ${uploadedBackupKey}`,
      );
      try {
        await storage.deleteBackup(uploadedBackupKey);
        console.log(
          '[Cleanup] PASS: Test object deleted cleanly from Backblaze B2.',
        );
      } catch (err) {
        console.error('[Cleanup] Warning: Failed to clean up B2 object:', err);
      }
    }
    workspace.close();
    appStore.close();
  }
}

main().catch((err) => {
  console.error('\nFAIL: Live E2E Qualification encountered an error:', err);
  process.exit(1);
});
