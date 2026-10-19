# Cloudflare Containers computer provider

OpenDots targets Cloudflare Workers plus the Durable Object Container API for remote computer execution. A Worker is the authenticated gateway; one Durable Object owns each Dot's Linux container. The container runs the pinned OpenBot computer service on port 4100.

The existing Node OpenDots server still enforces the Dot's browser/files/shell permissions and writes the audit records. Its Cloudflare provider adapter calls the worker lifecycle API for get, ensure and stop, then uses the same worker origin for computer protocol actions. The worker verifies the per-Dot HMAC token before proxying a request to that Dot's container.

## Persistence and lifecycle

Cloudflare container disks are ephemeral by default. The Durable Object snapshots the container's writable filesystem before an explicit stop or a five-minute idle stop. On the next start, it restores that snapshot. The snapshot includes the computer workspace and browser profile directories.

Durable Object Container snapshots do not include memory or running processes; the pinned computer entrypoint runs again after restore. The worker schedules a 25-day snapshot renewal when a Dot is stopped, because Cloudflare documents a 30-day snapshot TTL. The renewal restores and re-snapshots the filesystem, then stops the container again.

This is intended to preserve files and browser state across ordinary lifecycle operations; it is not an uptime SLA. Abrupt infrastructure failures and browser-profile consistency must be validated against a real Cloudflare deployment with the existing qualification harness.

## Cost and account requirements

Cloudflare Containers are not included on the Workers Free plan. The documented minimum is Workers Paid at $5 USD/month, plus usage-based charges for container memory, active CPU, disk, Durable Objects, and outbound network traffic.

The selected standard-1 instance provides 0.5 vCPU, 4 GiB memory, and 8 GB disk. The Workers Paid included allowances currently list 375 vCPU-minutes, 25 GiB-hours of memory, and 200 GB-hours of disk. At 4 GiB provisioned memory, the included memory allowance is about 6.25 instance-hours per month, before extra metered charges. Check current account pricing before provisioning.

Official sources:
- https://developers.cloudflare.com/containers/platform/pricing/
- https://developers.cloudflare.com/containers/platform/limits/
- https://developers.cloudflare.com/containers/guides/snapshots/

## Deploy the computer Worker

Run from the repository root:

    npx --yes wrangler login
    npx --yes wrangler deploy --config cloudflare-computer/wrangler.jsonc
    npx --yes wrangler secret put COMPUTER_PROVIDER_TOKEN --config cloudflare-computer/wrangler.jsonc
    npx --yes wrangler secret put COMPUTER_TOKEN --config cloudflare-computer/wrangler.jsonc

Use a separate long random COMPUTER_PROVIDER_TOKEN. Set the Worker secret COMPUTER_TOKEN to exactly the same stable master computer token used by OpenDots. Never commit either secret. The Worker passes only a per-Dot HMAC-derived token into a computer container; it does not pass the provider token or master token into the container.

After deployment, set these variables in the OpenDots server environment:

    COMPUTER_PROVIDER=cloudflare-containers
    CLOUDFLARE_COMPUTER_API_URL=https://opendots-computers.<your-workers-subdomain>.workers.dev
    CLOUDFLARE_COMPUTER_PROVIDER_TOKEN=<same-provider-token-as-Worker-secret>
    COMPUTER_TOKEN=<same-stable-master-computer-token-as-Worker-secret>

The worker URL must be a root HTTPS origin with no path, query or fragment. Restart the OpenDots app after changing environment values.

## Worker routes

- GET /__provider/computers/:dotId — inspect status without starting the computer.
- POST /__provider/computers/:dotId/ensure — create or restore the computer.
- POST /__provider/computers/:dotId/stop — snapshot and stop the container.
- GET /_health — liveness check.

The computer protocol remains at the origin root and includes routes such as /navigate, /snapshot, /files/read, and /control. Computer actions require the existing x-openbot-bot-id header and a per-Dot HMAC Authorization token.

## Qualification gate

After deploying and setting real secrets, run from the repository root:

    OPENDOTS_BASE_URL=https://your-opendots-host.example npm run qualify:computer

The live run must verify browser navigation, workspace writes/reads, and a browser cookie surviving the actual Cloudflare snapshot/stop/start. Local Docker CI and a Wrangler dry run do not count as live Cloudflare qualification.
