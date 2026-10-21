/**
 * Opt-in Backblaze B2 Live Smoke Test
 *
 * Requirements:
 * - Must be explicitly authorized via B2_SMOKE_TEST=true or --run flag.
 * - Uploads a small temporary encrypted backup object to B2.
 * - Downloads the object and verifies authenticated decryption and SHA-256 integrity.
 * - Cleans up the exact test object created without affecting unrelated objects.
 * - Never prints real secrets or credentials to logs or stdout.
 *
 * Usage:
 *   npx tsx tests/b2-smoke.ts --run
 *   or:
 *   cross-env B2_SMOKE_TEST=true npx tsx --env-file-if-exists=.env tests/b2-smoke.ts
 */

import { randomBytes } from 'node:crypto';
import {
  b2ConfigFromEnv,
  B2StorageAdapter,
  BackupService,
  resolveEncryptionKey,
} from '../src/server/backup/index.js';

async function runSmokeTest() {
  const isAuthorized =
    process.env.B2_SMOKE_TEST === 'true' || process.argv.includes('--run');

  if (!isAuthorized) {
    console.log('[B2 Smoke Test] Skipped.');
    console.log('To run the live Backblaze B2 smoke test, run:');
    console.log('  npx tsx --env-file-if-exists=.env tests/b2-smoke.ts --run');
    return;
  }

  console.log('[B2 Smoke Test] Starting live Backblaze B2 qualification...');

  const config = b2ConfigFromEnv(process.env);
  if (!config) {
    throw new Error('B2 storage configuration is not set in environment.');
  }

  // Safe logging: print endpoint, region, bucket - NEVER print keys
  console.log(`[B2 Smoke Test] Target Endpoint : ${config.endpoint}`);
  console.log(`[B2 Smoke Test] Target Region   : ${config.region}`);
  console.log(`[B2 Smoke Test] Target Bucket   : ${config.bucket}`);
  console.log(
    `[B2 Smoke Test] Key ID          : ...${config.keyId.slice(-4)} (redacted)`,
  );

  // Validate or provide a transient test encryption key if not configured in env
  let encKey: Buffer;
  try {
    encKey = resolveEncryptionKey(process.env);
    console.log('[B2 Smoke Test] Encryption Key  : configured in environment');
  } catch {
    console.log(
      '[B2 Smoke Test] OPENDOTS_BACKUP_ENCRYPTION_KEY not set; using ephemeral 256-bit test key for smoke test.',
    );
    encKey = randomBytes(32);
  }

  const adapter = new B2StorageAdapter(config);
  const service = new BackupService(adapter, encKey);

  const testDotId = 'opendots-qualification';
  const testPayload = Buffer.from(
    `OpenDots qualification probe: ${Date.now()}-${randomBytes(16).toString('hex')}`,
    'utf8',
  );

  let createdBackupId: string | null = null;

  try {
    console.log(
      '\n[1/3] Uploading encrypted & authenticated backup envelope...',
    );
    const envelope = await service.createBackup({
      dotId: testDotId,
      backupType: 'workspace',
      plaintext: testPayload,
      archiveFormat: 'raw',
    });
    createdBackupId = envelope.backupId;
    console.log(`[B2 Smoke Test] Uploaded backup ID: ${createdBackupId}`);
    console.log(
      `[B2 Smoke Test] Unencrypted SHA-256: ${envelope.integrity.unencryptedSha256}`,
    );

    console.log(
      '\n[2/3] Downloading, authenticating & verifying backup payload...',
    );
    const restored = await service.restoreBackup(
      testDotId,
      createdBackupId,
      'workspace',
    );

    if (!restored.plaintext.equals(testPayload)) {
      throw new Error(
        'Downloaded and decrypted payload did not match the original test data.',
      );
    }
    console.log(
      '[B2 Smoke Test] PASS: AES-256-GCM authentication tag and SHA-256 integrity verified.',
    );

    console.log('\n[3/3] Deleting temporary test object...');
    await service.deleteBackup(testDotId, createdBackupId, 'workspace');
    createdBackupId = null;
    console.log('[B2 Smoke Test] PASS: Test object deleted cleanly.');

    console.log(
      '\n===============================================================',
    );
    console.log('SUCCESS: Backblaze B2 durable storage qualification PASSED.');
    console.log(
      '===============================================================',
    );
  } catch (error) {
    console.error(
      `\n[B2 Smoke Test] FAIL: ${error instanceof Error ? error.message : String(error)}`,
    );
    throw error;
  } finally {
    if (createdBackupId) {
      console.warn(
        `[B2 Smoke Test] Attempting cleanup for lingering test object ${createdBackupId}...`,
      );
      try {
        await service.deleteBackup(testDotId, createdBackupId, 'workspace');
        console.warn('[B2 Smoke Test] Cleanup succeeded.');
      } catch (cleanupErr) {
        console.warn(
          `[B2 Smoke Test] Cleanup failed: ${cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr)}`,
        );
      }
    }
  }
}

runSmokeTest().catch(() => process.exit(1));
