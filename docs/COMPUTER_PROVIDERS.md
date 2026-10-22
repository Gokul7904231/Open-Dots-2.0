# Computer Provider Contract

## Purpose

The computer provider boundary lets OpenDots use different container, sandbox, or micro-VM backends without rewriting the Dot-facing computer API, permission model, audit log, or browser-action protocol.

The contract is implemented by `ComputerProvider` in `src/server/computer-provider.ts`. The current registered implementation is `docker-supervisor`; no remote cloud provider is implied by the abstraction.

## Interface contract

Each provider implements:

- `id`: stable provider key used for selection and diagnostics.
- `configured`: true only when all required provider control-plane settings are present.
- `get(dotId)`: inspect an existing computer without provisioning or waking it. Return `undefined` when the Dot has no instance.
- `ensure(dotId)`: idempotently create or recover that Dot's computer, returning a normalized state.
- `stop(dotId)`: stop compute without deleting the Dot's durable browser profile or workspace.

A returned state includes the same `dotId`, a normalized lifecycle status, and an optional computer API `endpoint`. When present, the endpoint must be a canonical HTTP(S) origin without credentials, path, query, or fragment. Only a state with `status: "running"` and a valid endpoint may be used for browser/file/shell actions.

## Security requirements

1. Validate Dot identifiers before interpolating them into provider paths or resource names.
2. Verify that the provider resource returned for a request is actually bound to the requested Dot. A provider must not trust a name or URL sent by the browser or owner.
3. Validate the endpoint against provider-owned identity information. For the Docker adapter this means exact container identity plus either the expected internal service DNS name or the configured loopback port. A future remote adapter must validate its own provider resource ID and canonical service origin, and should require HTTPS for remote endpoints.
4. Preserve the per-Dot HMAC credential derived by OpenDots. Do not forward the master computer token, supervisor token, owner token, model credentials, or other Dots' credentials into a computer.
5. Keep computer endpoints private where possible. If public routing is unavoidable, require the provider's authenticated private-access mechanism and continue validating the Dot-scoped bearer credential.
6. Do not allow a computer endpoint to contain userinfo, a non-root path, query parameters, or a fragment. Do not turn a user-supplied browser-navigation URL into a computer-service endpoint.
7. Propagate cancellation and bounded timeouts. Do not log browser inputs, file contents, shell commands, or credentials.

## Persistence and recovery requirements

- Computer identity is stable per Dot, even if the provider changes the underlying container or VM ID.
- `ensure` must be safe to call repeatedly and after interrupted operations.
- Browser profiles and workspace files must survive ordinary stop/start, instance replacement, and recoverable provider restarts.
- `stop` is non-destructive; deleting persistent data requires a separate explicit lifecycle and authorization design.
- The provider must report missing/unavailable instances honestly. The application must not silently substitute another Dot's computer or execute commands on the application host.
- Resource quotas, memory limits, provider API tokens, and provider-specific state belong inside the adapter and its deployment configuration—not in the Dot-facing API.

## Add a provider

1. Implement `ComputerProvider` in a separate server module. Do not add provider-specific paths or resource naming to `ComputerService`.
2. Validate provider resource identity, endpoint origin, TLS requirements, authentication, bounded response sizes, cancellation, and error sanitization.
3. Test missing instance, ensure/retry idempotency, stop/start persistence, wrong-Dot identity, malformed or foreign endpoints, provider outage, timeout, and secret redaction.
4. Register the provider in `src/server/computer-provider-factory.ts`.
5. Select it with `COMPUTER_PROVIDER=<registered-id>`. The factory fails closed for unknown provider names.
6. Record the provider's free/paid quota, sleep/expiry behavior, persistence guarantees, isolation model, regional eligibility, and end-to-end qualification separately. Implementing an adapter alone does not qualify a provider for production.

## Cloudflare Containers provider

The target remote provider is `cloudflare-containers`, implemented in `cloudflare-computer/`. It maps each Dot to one Durable Object and one Linux Container running the pinned OpenBot computer service. The OpenDots Node server uses `CLOUDFLARE_COMPUTER_API_URL` and `CLOUDFLARE_COMPUTER_PROVIDER_TOKEN`; the Cloudflare Worker uses a separate provider token and the same stable `COMPUTER_TOKEN` master secret as OpenDots.

The Worker checks the existing per-Dot HMAC credential before proxying computer actions. On explicit stop or idle timeout, it snapshots the container filesystem and stops compute; it restores the snapshot on the next start and refreshes dormant snapshot TTL every 25 days. The default remains `docker-supervisor` for local development until a live Cloudflare deployment passes qualification.

Cloudflare Containers are not available on Workers Free. The documented minimum is Workers Paid at $5/month plus metered compute, memory, disk, Durable Object, and egress usage. The selected `standard-1` instance has 0.5 vCPU, 4 GiB memory, and 8 GB disk. The monthly included memory allowance (25 GiB-hours) covers about 6.25 hours at that instance size. Review the current account plan and usage before provisioning.

See [Cloudflare computer setup](CLOUDFLARE_COMPUTERS.md) and the official [Containers pricing](https://developers.cloudflare.com/containers/platform/pricing/), [instance limits](https://developers.cloudflare.com/containers/platform/limits/), and [snapshot documentation](https://developers.cloudflare.com/containers/guides/snapshots/).

## Vercel Sandbox provider

The `vercel-sandbox` adapter (also selectable via `COMPUTER_PROVIDER=vercel`) provisions persistent Linux MicroVMs backed by Firecracker using the official `@vercel/sandbox` SDK (`^3.8.0`).

### Architecture & Identity

- **Stable Identity**: Each Dot is mapped 1:1 to a named sandbox: `${COMPUTER_NAMESPACE:-opendots}-computer-${dotId}`.
- **MicroVM Isolation**: Hardware-level guest virtualization with dedicated guest kernel, root/sudo execution, and native Linux package management.
- **Service Execution**: Runs the pinned OpenBot `agent-computer` service (from CopilotKit/OpenBot revision `b6932d31a8d6e7896c15139dfc27a6c6911deb27`) directly in the MicroVM on port `4100` via Bun.
- **Routing**: Exposes port `4100` as a secure HTTPS endpoint: `https://<subdomain>.vercel.run`. Non-root paths, non-HTTPS protocols, or foreign domains are strictly rejected by endpoint validation.

### Authentication & Credential Boundaries

- **Server-Side Management**: `VERCEL_TOKEN`, `VERCEL_TEAM_ID`, and `VERCEL_PROJECT_ID` (or `VERCEL_OIDC_TOKEN`) are held exclusively on the trusted OpenDots server. They are never injected into the Dot's workspace, browser, or environment.
- **Per-Dot Authentication**: The master `COMPUTER_TOKEN` never leaves the host. Each MicroVM receives only its Dot-specific HMAC derived token (`HMAC-SHA256(COMPUTER_TOKEN, "opendots-computer:" + dotId)`). Requests from OpenDots present this token, and `agent-computer` rejects unauthorized requests with HTTP 401.

### Persistence & B2 Storage Integration

- **Vercel Snapshot Semantics**: Persistent sandboxes (`persistent: true`) automatically snapshot disk state upon `stop()`.
- **Process Reconstruction**: On session resume, `onResume` restarts the background `agent-computer` daemon process with bounded `/health` readiness polling.
- **Durable B2 Backups**: Provider implements `exportData` and `importData` hooks for `workspace`, `browser-profile`, and `full-computer`:
  - **Profile Quiescence**: Stops compute/browser before archiving or restoring profile state to ensure Chromium flushes cookies and SQLite databases cleanly.
  - **Archive Safety**: Cryptographically validates and sanitizes archives (`extractArchive`) before writing, extracting via staging directories (`/tmp/staging-...`) to prevent partial or corrupted state.
  - **Eviction Recovery**: If a Vercel snapshot expires or is deleted (`snapshot_not_found`), the B2 durable storage layer restores the Dot's workspace and browser profiles.

### Resource Limits, Quotas & Costs

- **Execution Limits**: Default session timeout is 5 minutes (300,000 ms), extensible up to 45 minutes on Hobby and 24 hours on Pro/Enterprise.
- **Snapshot Retention**: By default, snapshots are retained according to the project policy (typically 7 days retention).
- **Billing**: Vercel Sandbox is a metered, billable cloud service based on active vCPU execution time, provisioned memory (2 GB RAM per vCPU), and network egress. It requires a valid Vercel account with billing enabled.
