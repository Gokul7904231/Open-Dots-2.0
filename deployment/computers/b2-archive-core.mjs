import { randomBytes } from 'node:crypto';
import {
  ARCHIVE_LIMITS,
  BACKUP_TYPES,
  createTarArchive,
  decodeOdar,
  encodeOdar,
  parseTarArchive,
} from './b2-archive-format.mjs';

// Dependencies that come from the pinned OpenBot supervisor (Docker client, derived
// names and labels) are injected so the logic below is testable without Bun or Docker.
export function createBackupSupervisor({
  docker,
  namespace: NAMESPACE,
  defaultNamespace: DEFAULT_NAMESPACE,
  labels: { owner: OWNER_LABEL, bot: BOT_LABEL, namespace: NAMESPACE_LABEL },
  image: imageFromEnv,
  log = console,
}) {
  const MAX_REQUEST_BYTES = ARCHIVE_LIMITS.maxArchiveBytes;

  // Backup and restore are mutually exclusive with every lifecycle verb for one Dot.
  // Both sets are synchronous check-and-set operations inside one event loop, so no
  // request can slip between the check and the claim. Across supervisor processes the
  // deterministic helper-container name below is the lock: Docker refuses a second
  // container with the same name.
  const activeBackupDots = new Set();
  const lifecycleInFlight = new Map();

  function isBackupLocked(botId) {
    return activeBackupDots.has(botId);
  }

  class BackupRouteError extends Error {
    constructor(statusCode, message) {
      super(message);
      this.statusCode = statusCode;
    }
  }

  async function withBackupLock(botId, callback) {
    if (activeBackupDots.has(botId)) {
      throw new BackupRouteError(
        409,
        'Another backup or restore operation is already active for this computer.',
      );
    }
    if ((lifecycleInFlight.get(botId) ?? 0) > 0) {
      throw new BackupRouteError(
        409,
        'A start, stop or reset is in progress for this computer.',
      );
    }
    activeBackupDots.add(botId);
    try {
      return await callback();
    } finally {
      activeBackupDots.delete(botId);
    }
  }

  const LIFECYCLE_PATH = /^\/computers\/([^/]+)\/(?:ensure|stop|reset)$/;

  /**
   * Hono middleware registered after authentication and before the lifecycle routes. It
   * refuses start/stop/reset while a backup holds the Dot, and holds a marker for the
   * duration of any lifecycle request so a backup cannot begin underneath it.
   */
  async function lifecycleGuard(context, next) {
    const match =
      context.req.method === 'POST'
        ? LIFECYCLE_PATH.exec(context.req.path)
        : null;
    if (!match) return next();
    let botId;
    try {
      botId = decodeURIComponent(match[1]);
    } catch {
      return next();
    }
    if (activeBackupDots.has(botId)) {
      return context.json(
        { error: 'Computer is being backed up or restored.' },
        409,
      );
    }
    lifecycleInFlight.set(botId, (lifecycleInFlight.get(botId) ?? 0) + 1);
    try {
      await next();
    } finally {
      const remaining = (lifecycleInFlight.get(botId) ?? 1) - 1;
      if (remaining <= 0) lifecycleInFlight.delete(botId);
      else lifecycleInFlight.set(botId, remaining);
    }
  }

  function safeBackupType(value) {
    if (typeof value !== 'string' || !BACKUP_TYPES.has(value)) {
      throw new BackupRouteError(
        400,
        'A valid backup type query parameter is required.',
      );
    }
    return value;
  }

  function isOurs(labels, names) {
    return (
      labels?.[OWNER_LABEL] === 'true' &&
      labels?.[BOT_LABEL] === names.botId &&
      (labels?.[NAMESPACE_LABEL] ?? DEFAULT_NAMESPACE) === NAMESPACE
    );
  }

  async function inspectOwnedComputer(names, allowMissing = false) {
    try {
      const info = await docker.getContainer(names.container).inspect();
      if (!isOurs(info.Config?.Labels, names)) {
        throw new BackupRouteError(404, 'Computer not found.');
      }
      return info;
    } catch (error) {
      // Do not mistake our own 404 for an absent Docker container: that is how an
      // unowned container with a colliding name could otherwise be adopted.
      if (error instanceof BackupRouteError) throw error;
      if (error?.statusCode === 404 && allowMissing) return null;
      if (error?.statusCode === 404)
        throw new BackupRouteError(404, 'Computer not found.');
      throw new BackupRouteError(
        503,
        'Computer supervisor could not inspect the computer.',
      );
    }
  }

  // A backup may only touch a volume the supervisor itself created for this exact Dot.
  // A missing volume is never created here: restoring into a blank volume would look
  // like a successful recovery of a computer that was never identified.
  async function requireOwnedVolume(volumeName, names) {
    let volume;
    try {
      volume = await docker.getVolume(volumeName).inspect();
    } catch (error) {
      if (error?.statusCode === 404) {
        throw new BackupRouteError(
          404,
          'Computer storage volume was not found. Start the computer once so its storage is provisioned, then retry.',
        );
      }
      throw new BackupRouteError(
        503,
        'Computer storage volume could not be inspected.',
      );
    }
    if (!isOurs(volume.Labels, names)) {
      throw new BackupRouteError(
        409,
        'Computer storage volume ownership mismatch.',
      );
    }
  }

  async function collectStream(stream, maximum, signal) {
    const chunks = [];
    let total = 0;
    const onAbort = () => {
      try {
        stream.destroy(new Error('Backup operation cancelled.'));
      } catch {}
    };
    if (signal?.aborted) onAbort();
    else signal?.addEventListener('abort', onAbort, { once: true });
    try {
      for await (const chunk of stream) {
        if (signal?.aborted)
          throw new BackupRouteError(499, 'Backup operation cancelled.');
        const buffer = Buffer.from(chunk);
        total += buffer.length;
        if (total > maximum) {
          try {
            stream.destroy();
          } catch {}
          throw new BackupRouteError(
            413,
            'Backup archive exceeds the size limit.',
          );
        }
        chunks.push(buffer);
      }
      return Buffer.concat(chunks);
    } finally {
      signal?.removeEventListener('abort', onAbort);
    }
  }

  async function exportPath(container, path, archiveType, signal) {
    const stream = await container.getArchive({ path });
    const tar = await collectStream(stream, MAX_REQUEST_BYTES, signal);
    return parseTarArchive(tar, path, archiveType);
  }

  async function exportComputerData(names, rawType, signal) {
    const type = safeBackupType(rawType);
    const info = await inspectOwnedComputer(names);
    if (info.State?.Running) {
      throw new BackupRouteError(
        409,
        'Stop the computer before exporting persistent volume data.',
      );
    }
    await requireOwnedVolume(names.workspaceVolume, names);
    await requireOwnedVolume(names.profileVolume, names);

    // Read from a short-lived helper with only this Dot's volumes mounted. This works
    // for stopped containers too and never requires exposing the Docker socket to a Dot.
    return withVolumeHelper(
      names,
      async (helper) => {
        const entries = [];
        if (type === 'workspace' || type === 'full-computer') {
          const workspaceEntries = await exportPath(
            helper,
            '/workspace',
            'workspace',
            signal,
          );
          entries.push(
            ...workspaceEntries.map((entry) => ({
              ...entry,
              path:
                type === 'full-computer'
                  ? 'workspace/' + entry.path
                  : entry.path,
            })),
          );
        }
        if (type === 'browser-profile' || type === 'full-computer') {
          // /profiles/<botId> inside the per-Dot profile volume is the exact path the
          // computer passes to Chromium (PROFILES_DIR defaults to /profiles).
          const profilePath = '/profiles/' + names.botId;
          // A Dot that never launched its browser has no profile directory yet. That is an
          // empty profile, and exporting must not create anything in the volume.
          if (await helperPathExists(helper, profilePath, signal)) {
            const profileEntries = await exportPath(
              helper,
              profilePath,
              'browser-profile',
              signal,
            );
            entries.push(
              ...profileEntries.map((entry) => ({
                ...entry,
                path:
                  type === 'full-computer'
                    ? 'browser-profile/' + entry.path
                    : entry.path,
              })),
            );
          }
        }
        return encodeOdar(type, entries);
      },
      signal,
    );
  }

  function shellPath(path) {
    return "'" + path.replace(/'/g, "'\\''") + "'";
  }

  async function collectExec(stream, signal) {
    const chunks = [];
    let total = 0;
    const maximum = 64 * 1024;
    const onAbort = () => {
      try {
        stream.destroy(new Error('Backup operation cancelled.'));
      } catch {}
    };
    if (signal?.aborted) onAbort();
    else signal?.addEventListener('abort', onAbort, { once: true });
    try {
      for await (const chunk of stream) {
        if (signal?.aborted)
          throw new BackupRouteError(499, 'Backup operation cancelled.');
        const buffer = Buffer.from(chunk);
        total += buffer.length;
        if (total > maximum) {
          try {
            stream.destroy();
          } catch {}
          throw new BackupRouteError(
            500,
            'Backup helper returned unexpected output.',
          );
        }
        chunks.push(buffer);
      }
      return Buffer.concat(chunks).toString('utf8');
    } finally {
      signal?.removeEventListener('abort', onAbort);
    }
  }

  async function readHelperOutput(helper, outputPath, signal) {
    try {
      const stream = await helper.getArchive({ path: outputPath });
      const tar = await collectStream(stream, 256 * 1024, signal);
      const entries = parseTarArchive(tar, '/dev/shm', 'workspace');
      const filename = outputPath.split('/').at(-1);
      return (
        entries
          .find((entry) => entry.path === filename)
          ?.data.toString('utf8')
          .replace(/[\r\n\t]+/g, ' ')
          .replace(/\s+/g, ' ')
          .trim()
          .slice(-1500) ?? '[helper output was unavailable]'
      );
    } catch (error) {
      if (signal?.aborted)
        throw new BackupRouteError(499, 'Backup operation cancelled.');
      const detail =
        error instanceof Error
          ? error.message.slice(0, 200)
          : String(error).slice(0, 200);
      return '[helper output could not be read: ' + detail + ']';
    }
  }

  async function execExitCode(helper, command, signal) {
    if (signal?.aborted)
      throw new BackupRouteError(499, 'Backup operation cancelled.');

    // Bun's node:http implementation does not reliably emit "upgrade" for Docker's
    // HTTP 101 exec hijack. Start detached, use an ordinary HTTP 200 response, then
    // inspect until Docker records the process exit status.
    const outputPath =
      '/dev/shm/.opendots-helper-output-' + randomBytes(8).toString('hex');
    const wrappedCommand =
      '{ ' + command + '; } > ' + shellPath(outputPath) + ' 2>&1';
    const exec = await helper.exec({
      Cmd: ['sh', '-c', wrappedCommand],
      User: '0',
      AttachStdout: false,
      AttachStderr: false,
      Tty: false,
    });
    const stream = await exec.start({
      Detach: true,
      Tty: false,
      hijack: false,
      stdin: false,
      abortSignal: signal,
    });
    await collectExec(stream, signal);

    const deadline = Date.now() + 120_000;
    let result;
    for (;;) {
      if (signal?.aborted)
        throw new BackupRouteError(499, 'Backup operation cancelled.');
      result = await exec.inspect({ abortSignal: signal });
      if (result.Running !== true) break;
      if (Date.now() >= deadline)
        throw new Error('Backup helper filesystem command timed out.');
      await new Promise((resolve) => setTimeout(resolve, 25));
    }

    const output =
      result.ExitCode === 0
        ? ''
        : await readHelperOutput(helper, outputPath, signal);
    return { exitCode: result.ExitCode, output };
  }

  function logHelperFailure(message) {
    // Preserve the client-facing generic error while leaving enough diagnostic
    // detail in supervisor logs to identify a failed filesystem operation.
    if (typeof log.error === 'function') log.error(message);
    else if (typeof log.warn === 'function') log.warn(message);
  }

  async function runHelper(helper, command, signal) {
    try {
      const result = await execExitCode(helper, command, signal);
      if (result.exitCode !== 0) {
        const output = result.output
          .replace(/[\r\n\t]+/g, ' ')
          .replace(/\s+/g, ' ')
          .trim()
          .slice(-1500);
        logHelperFailure(
          'Backup helper command failed (exit code ' +
            String(result.exitCode) +
            '): ' +
            command.slice(0, 400) +
            '; output: ' +
            (output || '[no output]'),
        );
        throw new BackupRouteError(
          500,
          'Backup helper filesystem operation failed.',
        );
      }
    } catch (error) {
      if (error instanceof BackupRouteError) throw error;
      const detail =
        error instanceof Error
          ? error.message.slice(0, 500)
          : String(error).slice(0, 500);
      logHelperFailure(
        'Backup helper command could not be completed: ' +
          command.slice(0, 400) +
          '; error: ' +
          detail,
      );
      throw new BackupRouteError(
        500,
        'Backup helper filesystem operation failed.',
      );
    }
  }

  async function helperPathExists(helper, path, signal) {
    try {
      const result = await execExitCode(
        helper,
        'test -d ' + shellPath(path),
        signal,
      );
      return result.exitCode === 0;
    } catch (error) {
      if (error instanceof BackupRouteError) throw error;
      throw new BackupRouteError(
        500,
        'Backup helper filesystem operation failed.',
      );
    }
  }

  async function withVolumeHelper(names, callback, signal) {
    const image = imageFromEnv();
    // One deterministic helper name per Dot. Docker rejects a second container with the
    // same name, which serialises backups even across supervisor processes. The helper
    // expires on its own if the supervisor dies mid-operation.
    const helperName = NAMESPACE + '-backup-helper-' + names.botId;
    let helper;
    try {
      helper = await docker.createContainer({
        name: helperName,
        Image: image,
        Entrypoint: ['sh', '-c'],
        Cmd: ['sleep 900'],
        Labels: {
          'opendots.backup.helper': 'true',
          [BOT_LABEL]: names.botId,
          [NAMESPACE_LABEL]: NAMESPACE,
        },
        HostConfig: {
          Binds: [
            names.profileVolume + ':/profiles',
            names.workspaceVolume + ':/workspace',
          ],
          NetworkMode: 'none',
          AutoRemove: true,
          ReadonlyRootfs: true,
          SecurityOpt: ['no-new-privileges:true'],
          CapDrop: ['ALL'],
          Memory: 512 * 1024 * 1024,
          PidsLimit: 64,
        },
      });
    } catch (error) {
      if (error?.statusCode === 409) {
        throw new BackupRouteError(
          409,
          'Another backup or restore operation is already active for this computer.',
        );
      }
      if (error?.statusCode === 404) {
        throw new BackupRouteError(
          503,
          'Backup helper image is not available on this Docker host.',
        );
      }
      throw new BackupRouteError(
        503,
        'Backup helper container could not be created.',
      );
    }
    try {
      await helper.start();
      return await callback(helper);
    } finally {
      // Cleanup must finish even when the client disconnected: no signal is passed.
      try {
        await helper.stop({ t: 1 });
      } catch {}
      try {
        await helper.remove({ force: true, v: false });
      } catch {}
    }
  }

  async function putEntries(helper, stagePath, entries, signal) {
    await runHelper(helper, 'mkdir -p ' + shellPath(stagePath), signal);
    const tar = createTarArchive(entries);
    try {
      await helper.putArchive(tar, { path: stagePath });
    } catch (error) {
      // Dockerode's putArchive failure is not a shell command, so runHelper cannot
      // report it. Keep the HTTP response generic, but expose the failing phase and
      // bounded, content-free Docker error in supervisor logs for live qualification.
      const message =
        error instanceof Error ? error.message : String(error);
      const detail = message.replace(/\s+/g, ' ').slice(0, 400);
      logHelperFailure(
        'Backup helper archive upload failed (target=' +
          stagePath +
          ', entries=' +
          String(entries.length) +
          ', tarBytes=' +
          String(tar.length ?? 'unknown') +
          '): ' +
          detail,
      );
      throw new BackupRouteError(
        500,
        'Backup helper could not write archive data to the staging directory.',
      );
    }
  }

  function listChildren(dir) {
    const d = shellPath(dir);
    return d + '/* ' + d + '/.[!.]* ' + d + '/..?*';
  }

  function workspaceSwapCommands(stage, rollback, failed) {
    const s = shellPath(stage);
    const r = shellPath(rollback);
    const f = shellPath(failed);
    const skip = 'case "$p" in ' + s + '|' + r + '|' + f + ') continue;; esac';
    return {
      moveOld:
        'set -eu; for p in /workspace/* /workspace/.[!.]* /workspace/..?*; do [ -e "$p" ] || [ -L "$p" ] || continue; ' +
        skip +
        '; mv -- "$p" ' +
        r +
        '/; done',
      moveNew:
        'set -eu; for p in ' +
        listChildren(stage) +
        '; do [ -e "$p" ] || [ -L "$p" ] || continue; mv -- "$p" /workspace/; done',
      // Failed new data is parked, old data returned, and only then is anything deleted.
      rollback:
        'set -eu; mkdir -p ' +
        f +
        '; for p in /workspace/* /workspace/.[!.]* /workspace/..?*; do [ -e "$p" ] || [ -L "$p" ] || continue; ' +
        skip +
        '; mv -- "$p" ' +
        f +
        '/; done; for p in ' +
        listChildren(rollback) +
        '; do [ -e "$p" ] || [ -L "$p" ] || continue; mv -- "$p" /workspace/; done; rm -rf ' +
        s +
        ' ' +
        r +
        ' ' +
        f,
      cleanup: 'rm -rf ' + s + ' ' + r + ' ' + f,
    };
  }

  // Swap and rollback commands are short filesystem moves. They deliberately ignore the
  // request's abort signal: stopping half way is what strands data in a rollback directory.
  async function swapWorkspace(helper, state) {
    const commands = workspaceSwapCommands(
      state.stage,
      state.rollback,
      state.failed,
    );
    await runHelper(helper, 'mkdir -p ' + shellPath(state.rollback));
    try {
      await runHelper(helper, commands.moveOld);
      await runHelper(helper, commands.moveNew);
    } catch (error) {
      try {
        await runHelper(helper, commands.rollback);
      } catch {
        throw new BackupRouteError(
          500,
          'Workspace restore failed and rollback needs operator recovery; rollback data was retained.',
        );
      }
      throw error;
    }
    return { ...state, swapped: true };
  }

  async function rollbackWorkspace(helper, state) {
    await runHelper(
      helper,
      workspaceSwapCommands(state.stage, state.rollback, state.failed).rollback,
    );
  }

  function profileSwapCommands(botId, stage, rollback) {
    const target = '/profiles/' + botId;
    const s = shellPath(stage);
    const r = shellPath(rollback);
    const t = shellPath(target);
    return {
      moveOld:
        'set -eu; if [ -e ' +
        t +
        ' ] || [ -L ' +
        t +
        ' ]; then mv -- ' +
        t +
        ' ' +
        r +
        '; fi',
      moveNew: 'set -eu; mv -- ' + s + ' ' + t,
      rollback:
        'set -eu; if [ -e ' +
        t +
        ' ] || [ -L ' +
        t +
        ' ]; then rm -rf ' +
        t +
        '; fi; if [ -e ' +
        r +
        ' ] || [ -L ' +
        r +
        ' ]; then mv -- ' +
        r +
        ' ' +
        t +
        '; fi; rm -rf ' +
        s,
      cleanup: 'rm -rf ' + s + ' ' + r,
    };
  }

  async function swapProfile(helper, state) {
    const commands = profileSwapCommands(
      state.botId,
      state.stage,
      state.rollback,
    );
    try {
      await runHelper(helper, commands.moveOld);
      await runHelper(helper, commands.moveNew);
    } catch (error) {
      try {
        await runHelper(helper, commands.rollback);
      } catch {
        throw new BackupRouteError(
          500,
          'Browser-profile restore failed and rollback needs operator recovery; rollback data was retained.',
        );
      }
      throw error;
    }
    return { ...state, swapped: true };
  }

  async function rollbackProfile(helper, state) {
    await runHelper(
      helper,
      profileSwapCommands(state.botId, state.stage, state.rollback).rollback,
    );
  }

  async function importComputerData(names, rawType, input, signal) {
    const type = safeBackupType(rawType);
    let entries;
    try {
      entries = decodeOdar(input, type);
    } catch (error) {
      // Archive validation errors are client errors and never touch persistent state.
      throw new BackupRouteError(
        400,
        error instanceof Error ? error.message : 'Invalid backup archive.',
      );
    }
    // A stopped or deleted computer may be restored directly into its owned named
    // volumes. A running container is never allowed to race profile/workspace writes.
    const computer = await inspectOwnedComputer(names, true);
    if (computer?.State?.Running) {
      throw new BackupRouteError(
        409,
        'Stop the computer before importing persistent volume data.',
      );
    }
    await requireOwnedVolume(names.workspaceVolume, names);
    await requireOwnedVolume(names.profileVolume, names);

    const workspaceEntries = [];
    const profileEntries = [];
    for (const entry of entries) {
      if (type === 'workspace') workspaceEntries.push(entry);
      else if (type === 'browser-profile') profileEntries.push(entry);
      else if (entry.path.startsWith('workspace/'))
        workspaceEntries.push({
          ...entry,
          path: entry.path.slice('workspace/'.length),
        });
      else if (entry.path.startsWith('browser-profile/'))
        profileEntries.push({
          ...entry,
          path: entry.path.slice('browser-profile/'.length),
        });
      else
        throw new BackupRouteError(
          400,
          'Full-computer archive contains an unknown data section.',
        );
    }
    const id = randomBytes(12).toString('hex');
    const workspace = {
      stage: '/workspace/.opendots-b2-stage-' + id,
      rollback: '/workspace/.opendots-b2-rollback-' + id,
      failed: '/workspace/.opendots-b2-failed-' + id,
    };
    const profile = {
      botId: names.botId,
      stage: '/profiles/.opendots-b2-stage-' + id,
      rollback: '/profiles/.opendots-b2-rollback-' + id,
    };
    const doWorkspace = type === 'workspace' || type === 'full-computer';
    const doProfile = type === 'browser-profile' || type === 'full-computer';

    await withVolumeHelper(
      names,
      async (helper) => {
        // Phase 1: stage everything. Nothing live has changed yet, so any failure here
        // (including a client disconnect) only needs the staging directories removed.
        try {
          if (doWorkspace)
            await putEntries(helper, workspace.stage, workspaceEntries, signal);
          if (doProfile)
            await putEntries(helper, profile.stage, profileEntries, signal);
        } catch (error) {
          try {
            if (doWorkspace)
              await runHelper(helper, 'rm -rf ' + shellPath(workspace.stage));
            if (doProfile)
              await runHelper(helper, 'rm -rf ' + shellPath(profile.stage));
          } catch {
            log.warn('Restore staging cleanup needs operator review.');
          }
          throw error instanceof BackupRouteError
            ? error
            : new BackupRouteError(
                500,
                'Backup staging failed; existing data was not modified.',
              );
        }
        if (signal?.aborted) {
          await runHelper(
            helper,
            'rm -rf ' +
              (doWorkspace ? shellPath(workspace.stage) + ' ' : '') +
              (doProfile ? shellPath(profile.stage) : ''),
          );
          throw new BackupRouteError(499, 'Backup operation cancelled.');
        }

        // Phase 2: commit. Both swaps run to completion regardless of the client.
        let workspaceState;
        let profileState;
        try {
          if (doWorkspace)
            workspaceState = await swapWorkspace(helper, workspace);
          if (doProfile) profileState = await swapProfile(helper, profile);
        } catch (error) {
          let rollbackFailed = false;
          if (workspaceState) {
            try {
              await rollbackWorkspace(helper, workspaceState);
            } catch {
              rollbackFailed = true;
            }
          }
          if (profileState) {
            try {
              await rollbackProfile(helper, profileState);
            } catch {
              rollbackFailed = true;
            }
          }

          if (rollbackFailed) {
            throw new BackupRouteError(
              500,
              'Restore failed; rollback directories were retained for manual recovery.',
            );
          }
          throw error;
        }

        // Phase 3: the restore is committed. A cleanup failure must not trigger a rollback,
        // and the leftover directories use reserved names that exports skip.
        if (workspaceState) {
          try {
            await runHelper(
              helper,
              workspaceSwapCommands(
                workspace.stage,
                workspace.rollback,
                workspace.failed,
              ).cleanup,
            );
          } catch {
            log.warn(
              'Workspace restore succeeded, but staging/rollback cleanup needs operator review.',
            );
          }
        }
        if (profileState) {
          try {
            await runHelper(
              helper,
              profileSwapCommands(names.botId, profile.stage, profile.rollback)
                .cleanup,
            );
          } catch {
            log.warn(
              'Browser-profile restore succeeded, but staging/rollback cleanup needs operator review.',
            );
          }
        }
      },
      signal,
    );
  }

  async function readRequestLimited(request, maximum, signal) {
    const declared = Number(request.headers.get('content-length') || '0');
    if (declared > maximum)
      throw new BackupRouteError(413, 'Backup upload exceeds the size limit.');
    const reader = request.body?.getReader();
    if (!reader)
      throw new BackupRouteError(400, 'Backup upload body is required.');
    const chunks = [];
    let total = 0;
    try {
      for (;;) {
        if (signal?.aborted)
          throw new BackupRouteError(499, 'Backup operation cancelled.');
        const item = await reader.read();
        if (item.done) break;
        total += item.value.length;
        if (total > maximum) {
          await reader.cancel();
          throw new BackupRouteError(
            413,
            'Backup upload exceeds the size limit.',
          );
        }
        chunks.push(Buffer.from(item.value));
      }
    } finally {
      reader.releaseLock();
    }
    return Buffer.concat(chunks);
  }

  function reportFailure(label, error) {
    if (error instanceof BackupRouteError) return;
    // Never log request bodies or archive contents, only the failure's own message.
    log.error(label, error instanceof Error ? error.message : 'unknown error');
  }

  function attachBackupRoutes(app, resolve) {
    app.get('/computers/:botId/export', async (context) => {
      try {
        const parsed = resolve(context.req.param('botId'));
        if (!parsed.ok) return context.json({ error: parsed.reason }, 400);
        const type = safeBackupType(context.req.query('type'));
        return await withBackupLock(parsed.names.botId, async () => {
          const archive = await exportComputerData(
            parsed.names,
            type,
            context.req.raw.signal,
          );
          return context.body(archive, 200, {
            'Content-Type': 'application/octet-stream',
            'Cache-Control': 'no-store',
          });
        });
      } catch (error) {
        reportFailure('Backup export failed:', error);
        const status =
          error instanceof BackupRouteError ? error.statusCode : 500;
        const message =
          error instanceof BackupRouteError
            ? error.message
            : 'Backup export failed.';
        return context.json({ error: message }, status);
      }
    });

    app.post('/computers/:botId/import', async (context) => {
      try {
        const parsed = resolve(context.req.param('botId'));
        if (!parsed.ok) return context.json({ error: parsed.reason }, 400);
        const type = safeBackupType(context.req.query('type'));
        const payload = await readRequestLimited(
          context.req.raw,
          MAX_REQUEST_BYTES,
          context.req.raw.signal,
        );
        return await withBackupLock(parsed.names.botId, async () => {
          await importComputerData(
            parsed.names,
            type,
            payload,
            context.req.raw.signal,
          );
          return context.json({
            imported: true,
            botId: parsed.names.botId,
            type,
          });
        });
      } catch (error) {
        reportFailure('Backup import failed:', error);
        const status =
          error instanceof BackupRouteError ? error.statusCode : 500;
        const message =
          error instanceof BackupRouteError
            ? error.message
            : 'Backup import failed.';
        return context.json({ error: message }, status);
      }
    });
  }

  return {
    MAX_REQUEST_BYTES,
    isBackupLocked,
    lifecycleGuard,
    attachBackupRoutes,
    exportComputerData,
    importComputerData,
  };
}
