# Backblaze B2 Durable Storage & Backup Adapter

OpenDots 2.0 supports encrypted, versioned, durable state backups stored in Backblaze B2 using the official AWS SDK for JavaScript v3 (`@aws-sdk/client-s3`) and Backblaze's S3-compatible API.

---

## 1. Overview & Architecture

OpenDots computers operate with persistent storage volumes:

- `/workspace`: Bot-produced project files, code, and documents.
- `/profiles/${botId}`: Persistent Chromium browser profiles (cookies, login sessions, localStorage, and IndexedDB).

Because object storage (B2) is not a mounted POSIX filesystem, B2 is used as a **durable snapshot and backup layer**, not a live block device. The backup subsystem ensures:

1. **Application-side authenticated encryption** using AES-256-GCM before any data leaves the host.
2. **Cryptographic tamper resistance** using 128-bit authentication tags and dual SHA-256 checksums (plaintext and ciphertext).
3. **Strict tenant isolation**: Backup keys and listings are partitioned deterministically per Dot (`backups/${dotId}/${backupType}/${backupId}.odbackup`), preventing cross-Dot enumeration or unauthorized restoration.
4. **Defense against malicious archives**: Strict path normalization prevents directory traversal (`../`, absolute paths, drive letters, null bytes) and enforces extraction budgets against zip bombs.
5. **No public bucket requirements**: B2 buckets remain strictly private. Presigned or public URLs are never generated for sensitive backup data.

---

## 2. Environment Configuration

Add the following environment variables to `.env`. The values below are placeholders only; never commit actual credentials or encryption keys:

```env
# S3-compatible Backblaze B2 endpoint URL
B2_S3_ENDPOINT=

# Region where your B2 bucket resides
B2_REGION=

# Name of the Backblaze B2 bucket
B2_BUCKET=

# Dedicated bucket-restricted B2 Application Key ID
B2_KEY_ID=replace-with-bucket-restricted-key-id

# Dedicated B2 Application Key secret
B2_APPLICATION_KEY=replace-with-secret-from-B2-console

# 256-bit encryption key (64 hex characters or 32+ character passphrase)
OPENDOTS_BACKUP_ENCRYPTION_KEY=generate-a-separate-64-character-hex-key
```

_Note: For backward compatibility, `B2_ENDPOINT` and `B2_BUCKET_NAME` are also supported._

### Application Key Permissions

Use a **bucket-restricted** Backblaze Application Key with the following minimal capabilities:

- `readFiles` (`s3:GetObject`, `s3:HeadObject`)
- `writeFiles` (`s3:PutObject`)
- `deleteFiles` (`s3:DeleteObject`)
- `listFileNames` (`s3:ListBucket` within bucket prefix)

Do **not** use the Backblaze Master Application Key.

---

## 3. Cryptographic Protection & Envelope Format

### Key Management

The encryption key is supplied strictly via `OPENDOTS_BACKUP_ENCRYPTION_KEY`.

- The key is **never generated randomly on startup**. A missing or lost key is treated as a recovery failure to prevent silent data loss.
- Reusing `B2_APPLICATION_KEY` as the backup encryption key is strictly prohibited and rejected at startup.

### Encryption Pipeline (AES-256-GCM)

1. **Nonce**: A cryptographically secure 12-byte (96-bit) initialization vector (IV) is generated uniquely per backup.
2. **Cipher**: The payload is encrypted with AES-256-GCM, producing a 16-byte (128-bit) authentication tag.
3. **Integrity Checksums**: SHA-256 digests are computed over both unencrypted plaintext and ciphertext.

### Wire Envelope Format (`ODBK` v1)

Each backup object stored in B2 is self-contained:

```text
+---------------------+-----------------------+------------------------+
| Magic Bytes (4 B)   | Format Version (4 B)  | Header Length (4 B)    |
| 'ODBK'              | uint32BE = 1          | uint32BE = N           |
+---------------------+-----------------------+------------------------+
| JSON Envelope Header (N Bytes)                                        |
| { dotId, backupId, createdAt, backupType, encryption, integrity, ... }|
+----------------------------------------------------------------------+
| Ciphertext Bytes (Encrypted Payload + GCM Auth Tag)                   |
+----------------------------------------------------------------------+
```

Deterministic object key path:
`backups/${dotId}/${backupType}/${backupId}.odbackup`

---

## 4. Lifecycle & Consistency Rules

### Docker volume layout (verified against OpenBot `b6932d3`)

The pinned supervisor derives these names from `COMPUTER_NAMESPACE` and the Dot id and mounts them into each computer container (`docker.ts` `hostConfig`; the computer reads `WORKSPACE_DIR` and `PROFILES_DIR`):

| Volume                          | Mounted at   | Contents                                                                            |
| ------------------------------- | ------------ | ----------------------------------------------------------------------------------- |
| `<namespace>-workspace-<dotId>` | `/workspace` | Bot-produced files (`WORKSPACE_DIR`)                                                |
| `<namespace>-profile-<dotId>`   | `/profiles`  | One directory per bot: the Chromium profile is `/profiles/<dotId>` (`PROFILES_DIR`) |

The container, the two derived volumes and the labels `openbot.supervisor`, `openbot.bot-id` and `openbot.namespace` are the only ownership evidence. Nothing else is persisted: the container, its environment and its per-Dot credential are recreated by `ensure`, so `full-computer` is exactly workspace plus profile.

### Supervisor export/import

`deployment/computers/` patches the pinned supervisor at image-build time (`harden-supervisor.mjs`) and adds `GET /computers/:dotId/export?type=` and `POST /computers/:dotId/import?type=`. `type` is required and is one of `workspace`, `browser-profile`, `full-computer`.

- **Authentication**: the routes sit behind the supervisor's existing bearer-token middleware, which is registered before them; only `/health` is open. The Dot id must be a plain identifier, and the container, both volumes and their labels must belong to that Dot and namespace. A missing volume is **never created**: restoring into a blank volume would look like recovering a computer that was never identified. Start the computer once to provision its storage, then restore.
- **Quiescence**: a running computer is refused with 409 (the OpenDots service stops it first). Start, stop and reset are refused while a backup runs, and a backup is refused while a lifecycle request is in flight. Across supervisor processes, the deterministic helper-container name `<namespace>-backup-helper-<dotId>` is the lock, because Docker refuses a duplicate name. A helper that outlives a crash expires on its own after 15 minutes. Run one supervisor per Docker host and namespace.
- **Isolation**: data is read and written by a short-lived helper (the computer image, `--network none`, all capabilities dropped, read-only root filesystem, 512 MiB, 64 pids) with only that Dot's two volumes mounted. The Docker socket is never exposed to a computer.
- **Limits**: archive 600 MiB, 500 MiB of file data, 10,000 files, 100 MiB per file. The patched `Bun.serve` accepts bodies up to 600 MiB (Bun's default is 128 MiB) and a 255 s idle timeout. Archives are built in memory, so the practical ceiling is lower on a small host.
- **Contents**: regular files with their bytes, permission bits (the executable bit is kept) and mtime. Symlinks, hard links, devices and sockets are rejected, except that Chromium's `Singleton*` coordination links are dropped from profiles. Empty directories are not preserved. Leftover `.opendots-b2-*` restore bookkeeping is never exported.
- **Restore**: the archive is fully decoded and validated before any state changes. It is staged inside the target volume, then committed by moving the old data aside and the new data in. The old data is deleted only after the whole commit succeeds. A failed or cancelled restore moves the old data back, and the commit and rollback steps ignore client disconnects so they cannot stop half way. `full-computer` commits workspace then profile and rolls both back on failure. If cleanup fails after a commit, the restore still succeeds and a warning is logged.

### Formats

`ODBK` is the B2 envelope (header plus AES-256-GCM ciphertext). `ODAR` is the gzip+JSON file archive inside it, exchanged with the supervisor. They are separate formats. The envelope's `archiveFormat` is `json` for `ODAR`; `tar` is only used between the supervisor and its helper and is never stored. `ODAR` stays version 1. Backups made before the supervisor existed carry millisecond timestamps and no `mode`; both are still accepted (timestamps are normalised, mode defaults to `0644`).

### Quiescent Browser Profile Snapshots

Browser profiles (`/profiles/${botId}`) contain active LevelDB databases, cookies, and session state managed by Chromium:

- **Do not snapshot a running browser while it is actively modifying files.** Archiving a live profile risks capturing mid-write SQLite or LevelDB states, causing corruption upon restore.
- **Automated lifecycle**: for `browser-profile` and `full-computer`, and for any provider that exports volumes directly (including `workspace`), `ComputerService`:
  1. Takes a per-Dot backup lock that pauses agent operations.
  2. Reads the provider's own running state, and stops the computer (gracefully, so Chromium flushes) only if it was running.
  3. Exports the quiescent volume data.
  4. Resumes the computer only if this operation stopped it. A resume failure is reported, including when it follows another failure.
- A configured provider's `exportData` and `importData` are authoritative: a failure is reported and never replaced by the lossy text-file fallback. The fallback is used only when a provider has no export hooks, and only for `workspace`.

### Verified Restoration & Staging Safety

1. **Cryptographic validation**: magic bytes (`ODBK`), version, Dot ownership, backup id, backup type, the AES-256-GCM tag and both SHA-256 digests are verified before anything else.
2. **Archive validation**: the payload must be a valid `ODAR` document of the requested type (opaque payloads are refused), with safe paths and budgets. Absolute paths, `../`, reserved names, size mismatches and oversized archives are rejected before any state changes.
3. **Quiescent import**: a running computer is stopped, then the provider applies the payload. Success is reported only after the provider confirms the import. A missing or unconfigured provider is an error, not a restore.
4. **Fail-safe**: the supervisor stages, swaps and rolls back as described above.
5. **Resume**: the computer is resumed only if this restore stopped it. If the data was restored but the resume fails, the error says so.
6. The decrypted payload is never returned to API callers or logged.

### HTTP API Endpoints

All backup routes are mounted under `/api` and require owner authentication:

| Method | Route                                              | Description                                                                                          |
| ------ | -------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `GET`  | `/api/dots/:id/computer/backups`                   | List all backups for a Dot (supports optional `?type=workspace` filter).                             |
| `POST` | `/api/dots/:id/computer/backups`                   | Create an encrypted snapshot. Body: `{"type": "workspace" \| "browser-profile" \| "full-computer"}`. |
| `POST` | `/api/dots/:id/computer/backups/:backupId/restore` | Restore a specific backup into the Dot's computer.                                                   |

### Provider Integration & Limitations

| Provider                                           | Workspace Backup / Restore                                                                                                   | Browser Profile Backup / Restore                                            | Status                                                             |
| -------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| **Local Docker Supervisor** (`docker-supervisor`)  | Supervisor routes implemented and verified against the pinned source. Live Docker round trip: see CI `Computer Integration`. | Same. Cookie survival is exercised by `npm run qualify:supervisor-archive`. | **IMPLEMENTED, NOT LIVE-QUALIFIED** until that workflow passes     |
| **Cloudflare Containers** (`cloudflare-container`) | Supported via workspace file actions                                                                                         | Pending container volume tar export hooks                                   | Partially supported                                                |
| **Vercel Sandbox / CodeSandbox**                   | Pending filesystem export integration                                                                                        | Pending microVM snapshot export API                                         | **Pending** (requires remote sandbox provider export/import hooks) |

---

## 5. Retention & Bucket Versioning Semantics

When bucket versioning is enabled on Backblaze B2:

- Calling `deleteBackup` issues an S3 `DeleteObject` command, which places a **Delete Marker** on the object.
- It does **not** permanently purge older historical versions or permanently free storage space.
- To permanently purge deleted versions and manage storage costs, configure Backblaze B2 **Lifecycle Rules** in the Backblaze Admin Console (e.g., "Keep only the last version" or "Delete previous versions after 7 days").

---

## 6. Testing & Qualification

### Evidence levels

| Level                          | What it proves                                                                                                                                                         | Where                                                                                                    |
| ------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| Unit / mocked                  | Logic, authentication ordering, rollback, locking and formats. Docker is faked; the restore shell commands are real.                                                   | `npm test` (`tests/b2-*.test.*`, `tests/docker-supervisor-backup-client.test.ts`)                        |
| Pinned source                  | The patch applies to the exact OpenBot revision, compiles under strict `tsc`, keeps the routes behind authentication, and the patched app answers requests. No Docker. | `npm run verify:supervisor`                                                                              |
| Live Docker                    | Real volumes, helper containers and a Chromium cookie.                                                                                                                 | `npm run qualify:supervisor-archive` against a running stack, run by the `Computer Integration` workflow |
| Live B2 with a mocked computer | B2 object storage and encryption only. **Not** a computer qualification.                                                                                               | `tests/b2-live-storage-mock-provider-qualification.ts`                                                   |

### Running Automated Unit & Integration Tests

Deterministic unit and integration tests verify B2 adapter operations, encryption, archive safety, lifecycle quiescence, and authenticated HTTP routes:

```bash
npx vitest run tests/b2-backup.test.ts tests/b2-computer-integration.test.ts tests/b2-supervisor-archive.test.mjs tests/b2-supervisor-core.test.mjs tests/docker-supervisor-backup-client.test.ts tests/computer.test.ts
```

### Running the Live Backblaze B2 Smoke Test

The live qualification probe uploads a small temporary test envelope to B2, verifies authenticated retrieval and integrity, and deletes the test object:

```bash
npx tsx --env-file-if-exists=.env tests/b2-smoke.ts --run
```

### Live B2 object test with a mocked computer provider

`tests/b2-live-storage-mock-provider-qualification.ts` exercises live B2 object operations and encryption through the OpenDots API, but it uses an in-memory virtual filesystem and a mocked computer provider. It is **not** a real Docker or supervisor qualification. Do not mark Docker workspace/profile restore as verified until the pinned supervisor image implements its export/import routes and the actual Docker-backed marker/cookie round trip passes.
