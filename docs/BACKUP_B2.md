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

Add the following environment variables to `.env`:

```env
# S3-compatible Backblaze B2 endpoint URL
B2_S3_ENDPOINT=https://s3.us-east-005.backblazeb2.com

# Region where your B2 bucket resides
B2_REGION=us-east-005

# Name of the Backblaze B2 bucket
B2_BUCKET=opendots-persistence-20261021

# Dedicated bucket-restricted B2 Application Key ID
B2_KEY_ID=005fdf16e54e49c0000000001

# Dedicated B2 Application Key secret
B2_APPLICATION_KEY=K005fEd5Y8oS83PekPmGlfBAyWWml7w

# 256-bit encryption key (64 hex characters or 32+ character passphrase)
OPENDOTS_BACKUP_ENCRYPTION_KEY=0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef
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

### Quiescent Browser Profile Snapshots

Browser profiles (`/profiles/${botId}`) contain active LevelDB databases, cookies, and session state managed by Chromium:

- **Do not snapshot a running browser while it is actively modifying files.** Archiving a live profile risks capturing mid-write SQLite or LevelDB states, causing corruption upon restore.
- **Automated Lifecycle**: When taking a `browser-profile` or `full-computer` snapshot, `ComputerService` automatically:
  1. Prevents new agent operations using per-Dot backup locks.
  2. Stops the computer process via `provider.stop(dotId)` to flush SQLite and LevelDB write-ahead logs.
  3. Exports the quiescent profile directory.
  4. Resumes the computer via `provider.ensure(dotId)` if it was running.
  5. Surfaces any resume failure clearly without silently leaving the computer offline.
- Workspace backups (`workspace`) do not stop Chromium because `/workspace` is independent of Chromium profile databases.

### Verified Restoration & Staging Safety

Restoration executes in a verified, fail-safe sequence:

1. **Cryptographic Validation**: The encrypted backup envelope is retrieved from B2, checking magic bytes (`ODBK`), envelope version, Dot ownership, and AES-256-GCM authentication tag. Plaintext and ciphertext SHA-256 hashes are verified before touching any files.
2. **Archive Safety Verification**: All archive entry paths are inspected before extraction. Absolute paths, `../` directory traversal attempts, symlink attacks, and zip-bombs exceeding resource budgets (max 500 MB total, max 10,000 files) are rejected outright.
3. **Quiescent Target Injection**: For browser profiles, running computers are quiesced before restored files are imported.
4. **Fail-Safe Integrity**: If an archive is corrupt or invalid, the restore fails immediately without modifying or corrupting existing working files.
5. **Resume**: Once verified and imported, the computer is safely resumed.

### HTTP API Endpoints

All backup routes are mounted under `/api` and require owner authentication:

| Method | Route                                              | Description                                                                                          |
| ------ | -------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `GET`  | `/api/dots/:id/computer/backups`                   | List all backups for a Dot (supports optional `?type=workspace` filter).                             |
| `POST` | `/api/dots/:id/computer/backups`                   | Create an encrypted snapshot. Body: `{"type": "workspace" \| "browser-profile" \| "full-computer"}`. |
| `POST` | `/api/dots/:id/computer/backups/:backupId/restore` | Restore a specific backup into the Dot's computer.                                                   |

### Provider Integration & Limitations

| Provider                                           | Workspace Backup / Restore                                             | Browser Profile Backup / Restore                                                      | Status                                                             |
| -------------------------------------------------- | ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| **Local Docker Supervisor** (`docker-supervisor`)  | Supported (direct HTTP file action & supervisor archive export/import) | Supported (quiescent volume export/import via `/computers/:botId/export` & `/import`) | **Verified**                                                       |
| **Cloudflare Containers** (`cloudflare-container`) | Supported via workspace file actions                                   | Pending container volume tar export hooks                                             | Partially supported                                                |
| **Vercel Sandbox / CodeSandbox**                   | Pending filesystem export integration                                  | Pending microVM snapshot export API                                                   | **Pending** (requires remote sandbox provider export/import hooks) |

---

## 5. Retention & Bucket Versioning Semantics

When bucket versioning is enabled on Backblaze B2:

- Calling `deleteBackup` issues an S3 `DeleteObject` command, which places a **Delete Marker** on the object.
- It does **not** permanently purge older historical versions or permanently free storage space.
- To permanently purge deleted versions and manage storage costs, configure Backblaze B2 **Lifecycle Rules** in the Backblaze Admin Console (e.g., "Keep only the last version" or "Delete previous versions after 7 days").

---

## 6. Testing & Qualification

### Running Automated Unit & Integration Tests

Deterministic unit and integration tests verify B2 adapter operations, encryption, archive safety, lifecycle quiescence, and authenticated HTTP routes:

```bash
npx vitest run tests/b2-backup.test.ts tests/b2-computer-integration.test.ts tests/computer.test.ts
```

### Running the Live Backblaze B2 Smoke Test

The live qualification probe uploads a small temporary test envelope to B2, verifies authenticated retrieval and integrity, and deletes the test object:

```bash
npx tsx --env-file-if-exists=.env tests/b2-smoke.ts --run
```
