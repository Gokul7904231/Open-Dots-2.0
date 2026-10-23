import { randomBytes } from "node:crypto";
import Docker from "dockerode";
import {
  BOT_LABEL,
  DEFAULT_NAMESPACE,
  NAMESPACE,
  NAMESPACE_LABEL,
  OWNER_LABEL,
} from "./names";
import {
  ARCHIVE_LIMITS,
  BACKUP_TYPES,
  createTarArchive,
  decodeOdar,
  encodeOdar,
  parseTarArchive,
} from "./b2-archive-format.mjs";

const MAX_REQUEST_BYTES = ARCHIVE_LIMITS.maxArchiveBytes;
const docker = new Docker(
  process.env.DOCKER_SOCKET ? { socketPath: process.env.DOCKER_SOCKET } : undefined,
);

class BackupRouteError extends Error {
  constructor(statusCode, message) {
    super(message);
    this.statusCode = statusCode;
  }
}

function safeBackupType(value) {
  if (!BACKUP_TYPES.has(value)) throw new BackupRouteError(400, "Invalid backup type.");
  return value;
}

function isOurs(labels, names) {
  return labels?.[OWNER_LABEL] === "true" &&
    labels?.[BOT_LABEL] === names.botId &&
    (labels?.[NAMESPACE_LABEL] ?? DEFAULT_NAMESPACE) === NAMESPACE;
}

async function inspectOwnedComputer(names, allowMissing = false) {
  try {
    const info = await docker.getContainer(names.container).inspect();
    if (!isOurs(info.Config?.Labels, names)) {
      throw new BackupRouteError(404, "Computer not found.");
    }
    return info;
  } catch (error) {
    if (error?.statusCode === 404 && allowMissing) return null;
    if (error?.statusCode === 404) throw new BackupRouteError(404, "Computer not found.");
    if (error instanceof BackupRouteError) throw error;
    throw new BackupRouteError(503, "Computer supervisor could not inspect the computer.");
  }
}

function assertSafeVolume(labels, names) {
  if (!isOurs(labels, names)) throw new BackupRouteError(409, "Computer storage volume ownership mismatch.");
}

async function ensureOwnedVolume(volumeName, names) {
  try {
    const volume = await docker.getVolume(volumeName).inspect();
    assertSafeVolume(volume.Labels, names);
    return;
  } catch (error) {
    if (error?.statusCode !== 404) {
      if (error instanceof BackupRouteError) throw error;
      throw new BackupRouteError(503, "Computer storage volume could not be inspected.");
    }
  }
  try {
    await docker.createVolume({
      Name: volumeName,
      Labels: {
        [OWNER_LABEL]: "true",
        [BOT_LABEL]: names.botId,
        [NAMESPACE_LABEL]: NAMESPACE,
      },
    });
  } catch (error) {
    if (error?.statusCode !== 409) throw new BackupRouteError(503, "Computer storage volume could not be created.");
    const volume = await docker.getVolume(volumeName).inspect();
    assertSafeVolume(volume.Labels, names);
  }
}

async function collectStream(stream, maximum, signal) {
  const chunks = [];
  let total = 0;
  const onAbort = () => {
    try { stream.destroy(new Error("Backup operation cancelled.")); } catch {}
  };
  if (signal?.aborted) onAbort();
  else signal?.addEventListener("abort", onAbort, { once: true });
  try {
    for await (const chunk of stream) {
      if (signal?.aborted) throw new BackupRouteError(499, "Backup operation cancelled.");
      const buffer = Buffer.from(chunk);
      total += buffer.length;
      if (total > maximum) {
        try { stream.destroy(); } catch {}
        throw new BackupRouteError(413, "Backup archive exceeds the size limit.");
      }
      chunks.push(buffer);
    }
    return Buffer.concat(chunks);
  } finally {
    signal?.removeEventListener("abort", onAbort);
  }
}

async function exportPath(container, path, archiveType, signal) {
  const stream = await container.getArchive({ path });
  const tar = await collectStream(stream, MAX_REQUEST_BYTES, signal);
  return parseTarArchive(tar, path, archiveType);
}

export async function exportComputerData(names, rawType, signal) {
  const type = safeBackupType(rawType);
  const info = await inspectOwnedComputer(names);
  if ((type === "browser-profile" || type === "full-computer") && info.State?.Running) {
    throw new BackupRouteError(409, "Stop the computer before exporting its Chromium profile.");
  }
  await ensureOwnedVolume(names.workspaceVolume, names);
  await ensureOwnedVolume(names.profileVolume, names);

  // Read from a short-lived helper with only this Dot's volumes mounted. This works
  // for stopped containers too and never requires exposing the Docker socket to a Dot.
  return withVolumeHelper(names, async (helper) => {
    const entries = [];
    if (type === "workspace" || type === "full-computer") {
      const workspaceEntries = await exportPath(helper, "/workspace", "workspace", signal);
      entries.push(...workspaceEntries.map((entry) => ({
        ...entry,
        path: type === "full-computer" ? "workspace/" + entry.path : entry.path,
      })));
    }
    if (type === "browser-profile" || type === "full-computer") {
      const profilePath = "/profiles/" + names.botId;
      const profileEntries = await exportPath(helper, profilePath, "browser-profile", signal);
      entries.push(...profileEntries.map((entry) => ({
        ...entry,
        path: type === "full-computer" ? "browser-profile/" + entry.path : entry.path,
      })));
    }
    return encodeOdar(type, entries);
  }, signal);
}

function shellPath(path) {
  return "'" + path.replace(/'/g, "'\\''") + "'";
}

async function collectExec(stream, signal) {
  const chunks = [];
  let total = 0;
  const maximum = 64 * 1024;
  const onAbort = () => {
    try { stream.destroy(new Error("Backup operation cancelled.")); } catch {}
  };
  if (signal?.aborted) onAbort();
  else signal?.addEventListener("abort", onAbort, { once: true });
  try {
    for await (const chunk of stream) {
      if (signal?.aborted) throw new BackupRouteError(499, "Backup operation cancelled.");
      const buffer = Buffer.from(chunk);
      total += buffer.length;
      if (total > maximum) {
        try { stream.destroy(); } catch {}
        throw new BackupRouteError(500, "Backup helper returned unexpected output.");
      }
      chunks.push(buffer);
    }
    return Buffer.concat(chunks).toString("utf8");
  } finally {
    signal?.removeEventListener("abort", onAbort);
  }
}

async function runHelper(helper, command, signal) {
  if (signal?.aborted) throw new BackupRouteError(499, "Backup operation cancelled.");
  let exec;
  try {
    exec = await helper.exec({
      Cmd: ["sh", "-lc", command],
      User: "0",
      AttachStdout: true,
      AttachStderr: true,
      Tty: true,
    });
    const stream = await exec.start({ hijack: true, stdin: false });
    await collectExec(stream, signal);
    const result = await exec.inspect();
    if (result.ExitCode !== 0) throw new BackupRouteError(500, "Backup helper filesystem operation failed.");
  } catch (error) {
    if (error instanceof BackupRouteError) throw error;
    throw new BackupRouteError(500, "Backup helper filesystem operation failed.");
  }
}

async function withVolumeHelper(names, callback, signal) {
  const image = process.env.COMPUTER_IMAGE?.trim() || "openbot-agent-computer:latest";
  const suffix = randomBytes(8).toString("hex");
  const helperName = NAMESPACE + "-backup-helper-" + suffix;
  const helper = await docker.createContainer({
    name: helperName,
    Image: image,
    Entrypoint: ["sh", "-lc"],
    Cmd: ["sleep 600"],
    Labels: {
      "opendots.backup.helper": "true",
      [BOT_LABEL]: names.botId,
      [NAMESPACE_LABEL]: NAMESPACE,
    },
    HostConfig: {
      Binds: [
        names.profileVolume + ":/profiles",
        names.workspaceVolume + ":/workspace",
      ],
      NetworkMode: "none",
      AutoRemove: true,
      SecurityOpt: ["no-new-privileges:true"],
      CapDrop: ["ALL"],
      Memory: 512 * 1024 * 1024,
      PidsLimit: 64,
    },
  });
  try {
    await helper.start();
    return await callback(helper, suffix);
  } finally {
    try { await helper.stop({ t: 1 }); } catch {}
    try { await helper.remove({ force: true, v: false }); } catch {}
  }
}

async function ensureStage(helper, path, signal) {
  await runHelper(helper, "mkdir -p " + shellPath(path), signal);
}

async function putEntries(helper, stagePath, entries, signal) {
  await ensureStage(helper, stagePath, signal);
  const tar = createTarArchive(entries);
  await helper.putArchive(tar, { path: stagePath });
}

function workspaceSwapCommands(stage, rollback) {
  const s = shellPath(stage);
  const r = shellPath(rollback);
  return {
    moveOld: "set -eu; for p in /workspace/* /workspace/.[!.]* /workspace/..?*; do [ -e \"$p\" ] || [ -L \"$p\" ] || continue; case \"$p\" in " + s + "|" + r + ") continue;; esac; mv -- \"$p\" " + r + "/; done",
    moveNew: "set -eu; for p in " + s + "/* " + s + "/.[!.]* " + s + "/..?*; do [ -e \"$p\" ] || [ -L \"$p\" ] || continue; mv -- \"$p\" /workspace/; done",
    rollback: "set -eu; failed=/workspace/.opendots-b2-failed-" + stage.split("-").at(-1) + "; mkdir -p \"$failed\"; for p in /workspace/* /workspace/.[!.]* /workspace/..?*; do [ -e \"$p\" ] || [ -L \"$p\" ] || continue; case \"$p\" in " + s + "|" + r + "|\"$failed\") continue;; esac; mv -- \"$p\" \"$failed\"/; done; for p in " + r + "/* " + r + "/.[!.]* " + r + "/..?*; do [ -e \"$p\" ] || [ -L \"$p\" ] || continue; mv -- \"$p\" /workspace/; done; rm -rf \"$failed\" " + s + " " + r,
    cleanup: "rm -rf " + s + " " + r,
  };
}

async function swapWorkspace(helper, stage, rollback, signal) {
  const commands = workspaceSwapCommands(stage, rollback);
  await runHelper(helper, "mkdir -p " + shellPath(rollback), signal);
  try {
    await runHelper(helper, commands.moveOld, signal);
  } catch (error) {
    try {
      await runHelper(helper, "set -eu; for p in " + shellPath(rollback) + "/* " + shellPath(rollback) + "/.[!.]* " + shellPath(rollback) + "/..?*; do [ -e \"$p\" ] || [ -L \"$p\" ] || continue; mv -- \"$p\" /workspace/; done", signal);
    } catch {
      throw new BackupRouteError(500, "Workspace snapshot failed and rollback needs operator recovery.");
    }
    throw error;
  }
  try {
    await runHelper(helper, commands.moveNew, signal);
  } catch (error) {
    try {
      await runHelper(helper, commands.rollback, signal);
    } catch {
      throw new BackupRouteError(500, "Workspace restore failed and rollback needs operator recovery.");
    }
    throw error;
  }
  return { stage, rollback, swapped: true };
}

async function rollbackWorkspace(helper, state, signal) {
  const commands = workspaceSwapCommands(state.stage, state.rollback);
  await runHelper(helper, commands.rollback, signal);
}

function profileSwapCommands(botId, stage, rollback) {
  const target = "/profiles/" + botId;
  const s = shellPath(stage);
  const r = shellPath(rollback);
  const t = shellPath(target);
  return {
    moveOld: "set -eu; if [ -e " + t + " ] || [ -L " + t + " ]; then mv -- " + t + " " + r + "; fi",
    moveNew: "mv -- " + s + " " + t,
    rollback: "set -eu; if [ -e " + t + " ] || [ -L " + t + " ]; then mv -- " + t + " " + s + "; fi; if [ -e " + r + " ] || [ -L " + r + " ]; then mv -- " + r + " " + t + "; fi; rm -rf " + s,
    cleanup: "rm -rf " + s + " " + r,
  };
}

async function swapProfile(helper, botId, stage, rollback, signal) {
  const commands = profileSwapCommands(botId, stage, rollback);
  try {
    await runHelper(helper, commands.moveOld, signal);
    await runHelper(helper, commands.moveNew, signal);
  } catch (error) {
    try {
      await runHelper(helper, commands.rollback, signal);
    } catch {
      throw new BackupRouteError(500, "Browser-profile restore failed and rollback needs operator recovery.");
    }
    throw error;
  }
  return { stage, rollback, botId, swapped: true };
}

async function rollbackProfile(helper, state, signal) {
  await runHelper(helper, profileSwapCommands(state.botId, state.stage, state.rollback).rollback, signal);
}

export async function importComputerData(names, rawType, input, signal) {
  const type = safeBackupType(rawType);
  const entries = decodeOdar(input, type);
  await ensureOwnedVolume(names.workspaceVolume, names);
  await ensureOwnedVolume(names.profileVolume, names);

  const workspaceEntries = [];
  const profileEntries = [];
  for (const entry of entries) {
    if (type === "workspace") workspaceEntries.push(entry);
    else if (type === "browser-profile") profileEntries.push(entry);
    else if (entry.path.startsWith("workspace/")) workspaceEntries.push({ ...entry, path: entry.path.slice("workspace/".length) });
    else if (entry.path.startsWith("browser-profile/")) profileEntries.push({ ...entry, path: entry.path.slice("browser-profile/".length) });
    else throw new BackupRouteError(400, "Full-computer archive contains an unknown data section.");
  }
  const id = randomBytes(12).toString("hex");
  const workspaceStage = "/workspace/.opendots-b2-stage-" + id;
  const workspaceRollback = "/workspace/.opendots-b2-rollback-" + id;
  const profileStage = "/profiles/.opendots-b2-stage-" + id;
  const profileRollback = "/profiles/.opendots-b2-rollback-" + id;
  let workspaceState;
  let profileState;
  await withVolumeHelper(names, async (helper) => {
    if (type === "workspace" || type === "full-computer") {
      await putEntries(helper, workspaceStage, workspaceEntries, signal);
    }
    if (type === "browser-profile" || type === "full-computer") {
      await putEntries(helper, profileStage, profileEntries, signal);
    }
    try {
      if (type === "workspace" || type === "full-computer") {
        workspaceState = await swapWorkspace(helper, workspaceStage, workspaceRollback, signal);
      }
      if (type === "browser-profile" || type === "full-computer") {
        profileState = await swapProfile(helper, names.botId, profileStage, profileRollback, signal);
      }
      if (workspaceState) {
        await runHelper(helper, workspaceSwapCommands(workspaceState.stage, workspaceState.rollback).cleanup, signal);
      }
      if (profileState) {
        await runHelper(helper, profileSwapCommands(names.botId, profileState.stage, profileState.rollback).cleanup, signal);
      }
    } catch (error) {
      let rollbackFailed = false;
      if (profileState) {
        try { await rollbackProfile(helper, profileState, signal); } catch { rollbackFailed = true; }
      }
      if (workspaceState) {
        try { await rollbackWorkspace(helper, workspaceState, signal); } catch { rollbackFailed = true; }
      }
      if (rollbackFailed) {
        throw new BackupRouteError(500, "Restore failed; rollback directories were retained for manual recovery.");
      }
      throw error;
    }
  }, signal);
}

async function readRequestLimited(request, maximum, signal) {
  const declared = Number(request.headers.get("content-length") || "0");
  if (declared > maximum) throw new BackupRouteError(413, "Backup upload exceeds the size limit.");
  const reader = request.body?.getReader();
  if (!reader) throw new BackupRouteError(400, "Backup upload body is required.");
  const chunks = [];
  let total = 0;
  try {
    for (;;) {
      if (signal?.aborted) throw new BackupRouteError(499, "Backup operation cancelled.");
      const item = await reader.read();
      if (item.done) break;
      total += item.value.length;
      if (total > maximum) {
        await reader.cancel();
        throw new BackupRouteError(413, "Backup upload exceeds the size limit.");
      }
      chunks.push(Buffer.from(item.value));
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks);
}

export function attachBackupRoutes(app, resolve) {
  app.get("/computers/:botId/export", async (context) => {
    try {
      const parsed = resolve(context.req.param("botId"));
      if (!parsed.ok) return context.json({ error: parsed.reason }, 400);
      const type = safeBackupType(context.req.query("type") || "workspace");
      const archive = await exportComputerData(parsed.names, type, context.req.raw.signal);
      return context.body(archive, 200, {
        "Content-Type": "application/octet-stream",
        "Cache-Control": "no-store",
      });
    } catch (error) {
      const status = error instanceof BackupRouteError ? error.statusCode : 500;
      const message = error instanceof BackupRouteError ? error.message : "Backup export failed.";
      return context.json({ error: message }, status);
    }
  });

  app.post("/computers/:botId/import", async (context) => {
    try {
      const parsed = resolve(context.req.param("botId"));
      if (!parsed.ok) return context.json({ error: parsed.reason }, 400);
      const type = safeBackupType(context.req.query("type") || "workspace");
      const payload = await readRequestLimited(context.req.raw, MAX_REQUEST_BYTES, context.req.raw.signal);
      await importComputerData(parsed.names, type, payload, context.req.raw.signal);
      return context.json({ imported: true, botId: parsed.names.botId, type });
    } catch (error) {
      const status = error instanceof BackupRouteError ? error.statusCode : 500;
      const message = error instanceof BackupRouteError ? error.message : "Backup import failed.";
      return context.json({ error: message }, status);
    }
  });
}
