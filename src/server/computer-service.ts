import { createHmac } from 'node:crypto';
import { z } from 'zod';
import {
  computerInputs,
  computerPermissionsSchema,
  type ComputerAction,
  type ComputerControl,
  type ComputerStatus,
} from '../shared/computer-types.js';
import type { WorkspaceStore } from './workspace.js';
import type { PlatformConfig } from './platform-config.js';
import type {
  ComputerProvider,
  ComputerProviderState,
} from './computer-provider.js';
import { createComputerProvider } from './computer-provider-factory.js';
const controlSchema = z.object({
  holder: z.enum(['bot', 'human']),
  requested: z.boolean(),
  transitioning: z.boolean(),
  resumeSnapshotRequired: z.boolean(),
  request: z.object({ id: z.string(), status: z.string() }).optional(),
});
import {
  createArchive,
  extractArchive,
  type ArchiveEntry,
  type BackupService,
  type BackupType,
} from './backup/index.js';

export class ComputerService {
  private readonly provider: ComputerProvider;
  private readonly backups?: BackupService;
  private readonly backupLocks = new Set<string>();
  constructor(
    private workspace: WorkspaceStore,
    private config: PlatformConfig,
    private paused: () => boolean,
    private transport: typeof fetch = fetch,
    private deadlineMs = 70000,
    providerOrBackups?: ComputerProvider | BackupService,
    backups?: BackupService,
  ) {
    let resolvedProvider: ComputerProvider | undefined;
    let resolvedBackups = backups;

    if (providerOrBackups) {
      if ('createBackup' in providerOrBackups) {
        resolvedBackups = providerOrBackups;
      } else {
        resolvedProvider = providerOrBackups;
      }
    }

    this.provider =
      resolvedProvider ?? createComputerProvider(config, transport, deadlineMs);
    this.backups = resolvedBackups;
  }
  get configured() {
    return !!this.config.computerToken?.trim() && this.provider.configured;
  }
  private token(id: string) {
    return createHmac('sha256', this.config.computerToken!.trim())
      .update(`opendots-computer:${id}`)
      .digest('hex');
  }
  private requireDot(id: string) {
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(id) || !this.workspace.dot(id))
      throw new Error('Dot not found.');
  }
  private allowed(
    id: string,
    kind: 'browser' | 'files' | 'shell' | undefined,
    actor: 'agent' | 'owner',
  ) {
    this.requireDot(id);
    if (!this.configured)
      throw new Error('Computer service is not configured.');
    if (this.backupLocks.has(id) && actor === 'agent')
      throw new Error(
        'Computer operations are paused: backup or restore is in progress.',
      );
    const policy = this.workspace.computers.permissions(id);
    if (!policy.enabled || (kind && !policy[kind]))
      throw new Error('Computer permission is disabled.');
    if (actor === 'agent' && this.paused())
      throw new Error('Agents are paused.');
  }
  private async json(
    url: string,
    token: string,
    body: unknown | undefined,
    signal?: AbortSignal,
    dotId?: string,
  ): Promise<unknown> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.deadlineMs);
    const combined = signal
      ? AbortSignal.any([signal, controller.signal])
      : controller.signal;
    try {
      const response = await this.transport(url, {
        method: body === undefined ? 'GET' : 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
          ...(dotId ? { 'x-openbot-bot-id': dotId } : {}),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        redirect: 'error',
        signal: combined,
      });
      if (response.status === 409)
        throw new Error(
          'Computer service returned HTTP 409: refresh the browser with computer_snapshot before retrying. If the owner has control, wait for them to release it; do not bypass takeover.',
        );
      if (!response.ok)
        throw new Error(`Computer service returned HTTP ${response.status}.`);
      if (!response.body)
        throw new Error('Computer service returned an empty response.');
      const reader = response.body.getReader();
      let size = 0;
      const chunks: Uint8Array[] = [];
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.length;
        if (size > 4_000_000) {
          await reader.cancel();
          throw new Error('Computer response exceeded its size limit.');
        }
        chunks.push(value);
      }
      // Infrastructure secrets must never leave the gateway even if an upstream response reflects one.
      let text = Buffer.concat(chunks).toString('utf8');
      for (const secret of [
        token,
        this.config.computerToken?.trim(),
        this.config.computerSupervisorToken?.trim(),
      ])
        if (secret) text = text.split(secret).join('[redacted]');
      return JSON.parse(text);
    } catch (error) {
      if (combined.aborted)
        throw new Error('Computer request was cancelled or timed out.', {
          cause: error,
        });
      if (
        error instanceof Error &&
        /^Computer (service returned|response exceeded)/.test(error.message)
      )
        throw error;
      throw new Error(
        'Computer service is unavailable or returned an invalid response.',
        { cause: error },
      );
    } finally {
      clearTimeout(timeout);
    }
  }
  private endpoint(id: string, state: ComputerProviderState) {
    if (state.dotId !== id)
      throw new Error('Computer provider identity mismatch.');
    if (!state.endpoint)
      throw new Error('Computer provider did not return a computer endpoint.');
    const url = new URL(state.endpoint);
    const secureProtocol =
      url.protocol === 'https:' ||
      (this.provider.id === 'docker-supervisor' && url.protocol === 'http:');
    if (
      !secureProtocol ||
      url.username ||
      url.password ||
      url.pathname !== '/' ||
      url.search ||
      url.hash
    )
      throw new Error('Computer provider endpoint is invalid.');
    return url.origin;
  }
  private async running(id: string, signal?: AbortSignal) {
    const state = await this.provider.get(id, signal);
    if (!state || state.status !== 'running')
      throw new Error('Start this Dot’s computer first.');
    return this.endpoint(id, state);
  }
  async status(id: string): Promise<ComputerStatus> {
    this.requireDot(id);
    const base = {
      configured: this.configured,
      permissions: this.workspace.computers.permissions(id),
      audit: this.workspace.computers.audit(id),
    };
    if (!this.configured) return { ...base, state: 'not_configured' };
    try {
      const state = await this.provider.get(id);
      if (!state || state.status !== 'running')
        return { ...base, state: 'stopped' };
      const url = this.endpoint(id, state);
      const control = controlSchema.parse(
        await this.json(
          `${url}/control`,
          this.token(id),
          undefined,
          undefined,
          id,
        ),
      );
      return { ...base, state: 'running', control };
    } catch {
      return {
        ...base,
        state: 'unavailable',
        error:
          'Computer service is unavailable. Check the provider configuration and connection.',
      };
    }
  }
  private async audited<T>(
    id: string,
    action: string,
    actor: 'owner' | 'agent',
    fn: () => Promise<T>,
  ): Promise<T> {
    this.requireDot(id);
    const receipt = this.workspace.computers.begin(id, action, actor);
    try {
      const result = await fn();
      this.workspace.computers.finish(receipt, 'succeeded');
      return result;
    } catch (error) {
      this.workspace.computers.finish(receipt, 'failed');
      throw error;
    }
  }
  async permissions(id: string, input: unknown) {
    const patch = computerPermissionsSchema.partial().parse(input);
    await this.audited(id, 'permissions', 'owner', async () =>
      this.workspace.computers.patch(id, patch),
    );
    return this.status(id);
  }
  async start(id: string) {
    await this.audited(id, 'start', 'owner', async () => {
      this.allowed(id, undefined, 'owner');
      this.endpoint(id, await this.provider.ensure(id));
    });
    return this.status(id);
  }
  async stop(id: string) {
    await this.audited(id, 'stop', 'owner', async () => {
      if (!this.configured)
        throw new Error('Computer service is not configured.');
      await this.provider.stop(id);
    });
    return this.status(id);
  }
  async control(id: string, verb: 'take' | 'release') {
    await this.audited(id, verb, 'owner', async () => {
      if (!this.configured)
        throw new Error('Computer service is not configured.');
      if (verb === 'take') this.allowed(id, 'browser', 'owner');
      const url = await this.running(id);
      if (verb === 'take') this.allowed(id, 'browser', 'owner');
      let control: ComputerControl = controlSchema.parse(
        await this.json(
          `${url}/control`,
          this.token(id),
          undefined,
          undefined,
          id,
        ),
      );
      if (verb === 'take' && !control.request)
        control = controlSchema.parse(
          await this.json(
            `${url}/control/request`,
            this.token(id),
            { reason: 'Owner requested control.' },
            undefined,
            id,
          ),
        );
      if (
        verb === 'take' &&
        control.request &&
        !['waiting', 'taken'].includes(control.request.status)
      )
        control = controlSchema.parse(
          await this.json(
            `${url}/control/request`,
            this.token(id),
            { reason: 'Owner requested control.' },
            undefined,
            id,
          ),
        );
      if (!control.request)
        throw new Error('There is no active control request.');
      await this.json(
        `${url}/control/${verb}`,
        this.token(id),
        { requestId: control.request.id },
        undefined,
        id,
      );
    });
    return this.status(id);
  }
  async action(
    id: string,
    action: ComputerAction,
    input: unknown,
    actor: 'owner' | 'agent' = 'owner',
    signal?: AbortSignal,
  ): Promise<unknown> {
    if (!Object.hasOwn(computerInputs, action))
      throw new Error('Unknown computer action.');
    const parsed = computerInputs[action].parse(input);
    return this.audited(id, action, actor, async () => {
      if (actor === 'agent' && action.startsWith('human_'))
        throw new Error('Human controls are owner-only.');
      const kind =
        action === 'exec'
          ? 'shell'
          : action.startsWith('files_')
            ? 'files'
            : 'browser';
      this.allowed(id, kind, actor);
      const cancellation = new AbortController();
      const activeSignal = signal
        ? AbortSignal.any([signal, cancellation.signal])
        : cancellation.signal;
      const watcher = setInterval(() => {
        try {
          this.allowed(id, kind, actor);
        } catch {
          cancellation.abort();
        }
      }, 50);
      try {
        const url = await this.running(id, activeSignal);
        this.allowed(id, kind, actor);
        activeSignal.throwIfAborted();
        const path = action
          .replace(/^files_/, 'files/')
          .replace(/^human_/, 'human/');
        const result = await this.json(
          `${url}/${path}`,
          this.token(id),
          ['read', 'screenshot'].includes(action) ? undefined : parsed,
          activeSignal,
          id,
        );
        this.allowed(id, kind, actor);
        if (action === 'exec' && result && typeof result === 'object') {
          const copy = { ...result } as Record<string, unknown>;
          delete copy.command;
          return copy;
        }
        return result;
      } finally {
        clearInterval(watcher);
      }
    });
  }

  get backupService(): BackupService | undefined {
    return this.backups;
  }

  /**
   * Creates an encrypted durable backup for a Dot's computer state.
   *
   * Bounded consistency lifecycle:
   * 1. Prevents concurrent agent operations via backup lock.
   * 2. Quiesces/stops Chromium when backing up browser-profile to avoid SQLite/LevelDB corruption.
   * 3. Exports actual files/profile data from provider or computer API.
   * 4. Uploads and verifies the encrypted backup envelope in Backblaze B2.
   * 5. Resumes computer if it was running before the operation.
   * 6. Records and reports failures cleanly.
   */
  async snapshot(
    id: string,
    type: BackupType = 'workspace',
    data?: Buffer,
    signal?: AbortSignal,
  ) {
    this.requireDot(id);
    if (!this.backups) {
      throw new Error(
        'Durable backup service is not configured. Configure B2 storage credentials and OPENDOTS_BACKUP_ENCRYPTION_KEY.',
      );
    }
    return this.audited(id, `backup_${type}`, 'owner', async () => {
      if (this.backupLocks.has(id)) {
        throw new Error(
          `Another backup or restore operation is already in progress for Dot ${id}.`,
        );
      }
      this.backupLocks.add(id);

      let stoppedForSnapshot = false;
      try {
        // Lifecycle state comes from the provider itself. The control-API probe in
        // status() reports a running but unresponsive computer as unavailable, which
        // would skip the stop and export from under a live browser.
        const wasRunning = await this.isRunning(id, signal);

        let payload: Buffer;
        if (data) {
          payload = data;
        } else {
          // A direct volume-export provider must snapshot a stable filesystem, even for
          // workspace-only backups. Browser profiles always require Chromium quiescence.
          const volumeExport =
            this.provider.configured && !!this.provider.exportData;
          const quiescenceRequired =
            type === 'browser-profile' ||
            type === 'full-computer' ||
            volumeExport;
          if (wasRunning && quiescenceRequired) {
            stoppedForSnapshot = true;
            await this.provider.stop(id, signal);
          }
          payload = await this.exportComputerData(id, type, wasRunning, signal);
        }

        const envelope = await this.backups!.createBackup({
          dotId: id,
          backupType: type,
          plaintext: payload,
          signal,
        });

        // Resume only when this snapshot actually stopped a previously running computer.
        if (stoppedForSnapshot) {
          try {
            await this.provider.ensure(id, signal);
            stoppedForSnapshot = false;
          } catch (resumeErr) {
            // The outer handler must not retry a resume that just failed.
            stoppedForSnapshot = false;
            throw new Error(
              `Backup created successfully (${envelope.backupId}) but failed to resume computer: ${resumeErr instanceof Error ? resumeErr.message : String(resumeErr)}`,
              { cause: resumeErr },
            );
          }
        }

        return envelope;
      } catch (error) {
        // Attempt recovery to avoid leaving running computers stopped, and say so if
        // that recovery fails too.
        if (stoppedForSnapshot) {
          try {
            await this.provider.ensure(id, signal);
          } catch (resumeErr) {
            throw new Error(
              `${error instanceof Error ? error.message : String(error)} Additionally, the computer could not be resumed: ${resumeErr instanceof Error ? resumeErr.message : String(resumeErr)}`,
              { cause: resumeErr },
            );
          }
        }
        throw error;
      } finally {
        this.backupLocks.delete(id);
      }
    });
  }

  /**
   * Restores an encrypted durable backup for a Dot.
   *
   * 1. Downloads, authenticates, and decrypts backup from B2.
   * 2. Validates envelope version, Dot identity, backup identity, and SHA-256 digests.
   * 3. Validates archive entry paths (path traversal & zip bomb prevention).
   * 4. Stops computer if running before writing data.
   * 5. Imports verified data into target computer/volumes.
   * 6. Resumes computer if it was running before restore.
   */
  async restore(
    id: string,
    backupId: string,
    type: BackupType = 'workspace',
    signal?: AbortSignal,
  ) {
    this.requireDot(id);
    if (!this.backups) {
      throw new Error(
        'Durable backup service is not configured. Configure B2 storage credentials and OPENDOTS_BACKUP_ENCRYPTION_KEY.',
      );
    }
    return this.audited(id, `restore_${type}`, 'owner', async () => {
      if (this.backupLocks.has(id)) {
        throw new Error(
          `Another backup or restore operation is already in progress for Dot ${id}.`,
        );
      }
      this.backupLocks.add(id);

      let stoppedForRestore = false;
      try {
        // 1. Download and decrypt through BackupService with cryptographic integrity checks
        const restored = await this.backups!.restoreBackup(
          id,
          backupId,
          type,
          signal,
        );
        if (restored.envelope.backupType !== type) {
          throw new Error(
            'Backup type does not match the requested restore type.',
          );
        }

        // 2. Validate the ODAR payload (format, type, path safety, budgets) before any
        // computer state is modified. Unrecognised payloads are never applied.
        extractArchive(restored.plaintext, undefined, {
          strict: true,
          expectedType: type,
        });

        // Import requires a configured provider. Otherwise returning restored=true
        // would falsely report success without applying the verified payload.
        if (!this.provider.configured) {
          throw new Error(
            'Computer provider is not configured; backup was verified but not applied.',
          );
        }
        const wasRunning = await this.isRunning(id, signal);

        // Stop for every restore type: even workspace imports can race with shell
        // processes writing under /workspace, and a Chromium profile needs quiescence.
        if (wasRunning) {
          stoppedForRestore = true;
          await this.provider.stop(id, signal);
        }

        // 3. Import verified data into the target Dot or its persistent volumes.
        await this.importComputerData(
          id,
          type,
          restored.plaintext,
          wasRunning,
          signal,
        );

        // 4. Resume only when this restore stopped a previously running computer.
        if (stoppedForRestore) {
          try {
            await this.provider.ensure(id, signal);
            stoppedForRestore = false;
          } catch (resumeErr) {
            stoppedForRestore = false;
            throw new Error(
              `Backup ${backupId} was restored but the computer failed to resume: ${resumeErr instanceof Error ? resumeErr.message : String(resumeErr)}`,
              { cause: resumeErr },
            );
          }
        }

        // The decrypted payload is deliberately not returned to callers.
        return {
          restored: true,
          backupId,
          type,
          dotId: id,
          byteLength: restored.plaintext.length,
          envelope: restored.envelope,
        };
      } catch (error) {
        // A failed import leaves the previous data in place (the supervisor rolls back),
        // so bring a computer this restore stopped back up. Report if that also fails.
        if (stoppedForRestore) {
          try {
            await this.provider.ensure(id, signal);
          } catch (resumeErr) {
            throw new Error(
              `${error instanceof Error ? error.message : String(error)} Additionally, the computer could not be resumed: ${resumeErr instanceof Error ? resumeErr.message : String(resumeErr)}`,
              { cause: resumeErr },
            );
          }
        }
        throw error;
      } finally {
        this.backupLocks.delete(id);
      }
    });
  }

  private async isRunning(id: string, signal?: AbortSignal) {
    const state = await this.provider.get(id, signal);
    return state?.status === 'running';
  }

  async listBackups(id: string, type?: BackupType, signal?: AbortSignal) {
    this.requireDot(id);
    if (!this.backups) return [];
    return this.backups.listDotBackups(id, type, signal);
  }

  private async exportComputerData(
    id: string,
    type: BackupType,
    wasRunning: boolean,
    signal?: AbortSignal,
  ): Promise<Buffer> {
    if (this.provider.exportData && this.provider.configured) {
      // A configured provider hook is authoritative. Do not hide its failures by
      // silently falling back to text-only file actions, which corrupt binary data.
      return await this.provider.exportData(id, type, signal);
    }

    if (type === 'workspace') {
      let startedForExport = false;
      if (!wasRunning && this.provider.configured) {
        await this.provider.ensure(id, signal);
        startedForExport = true;
      }
      try {
        return await this.exportWorkspaceFiles(id, signal);
      } finally {
        if (startedForExport) {
          await this.provider.stop(id, signal);
        }
      }
    }

    throw new Error(
      `Computer provider "${this.provider.id}" does not support exporting "${type}" data.`,
    );
  }

  private async importComputerData(
    id: string,
    type: BackupType,
    data: Buffer,
    wasRunning: boolean,
    signal?: AbortSignal,
  ): Promise<void> {
    if (this.provider.importData && this.provider.configured) {
      // Do not turn a provider's failed binary import into a text-file fallback.
      await this.provider.importData(id, type, data, signal);
      return;
    }

    if (type === 'workspace') {
      // This fallback uses the computer HTTP API, so it must run a computer while
      // the supervisor-backed import path can operate directly on stopped volumes.
      const current = await this.provider.get(id, signal);
      const startedForImport = !current || current.status !== 'running';
      if (startedForImport) await this.provider.ensure(id, signal);
      try {
        await this.importWorkspaceFiles(id, data, signal);
        return;
      } finally {
        // Preserve the original lifecycle: leave it running when it was running before
        // restore; otherwise return a temporary import computer to the stopped state.
        if (startedForImport && !wasRunning) {
          await this.provider.stop(id, signal);
        }
      }
    }

    throw new Error(
      `Computer provider "${this.provider.id}" does not support importing "${type}" data.`,
    );
  }

  private async exportWorkspaceFiles(
    id: string,
    signal?: AbortSignal,
  ): Promise<Buffer> {
    const listResult = (await this.action(
      id,
      'files_list',
      { path: '' },
      'owner',
      signal,
    )) as {
      entries?: Array<{ path: string; isDirectory?: boolean; type?: string }>;
    };

    const entries = listResult?.entries ?? [];
    const files = entries.filter(
      (e) => !e.isDirectory && e.type !== 'directory',
    );

    const archiveEntries: ArchiveEntry[] = [];
    for (const file of files) {
      const readResult = (await this.action(
        id,
        'files_read',
        { path: file.path },
        'owner',
        signal,
      )) as { contents?: string; text?: string; data?: string };

      const content =
        readResult.contents ?? readResult.text ?? readResult.data ?? '';
      archiveEntries.push({
        path: file.path,
        data: Buffer.from(content, 'utf8'),
      });
    }

    return createArchive('workspace', archiveEntries);
  }

  private async importWorkspaceFiles(
    id: string,
    data: Buffer,
    signal?: AbortSignal,
  ): Promise<void> {
    const entries = extractArchive(data);
    for (const entry of entries) {
      await this.action(
        id,
        'files_write',
        {
          path: entry.path,
          contents: entry.data.toString('utf8'),
        },
        'owner',
        signal,
      );
    }
  }
}
