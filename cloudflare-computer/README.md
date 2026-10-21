# OpenDots Cloudflare computer runtime

This directory is the dedicated Cloudflare Worker + Durable Object Container runtime for OpenDots computers.

- One validated Dot ID maps to one Durable Object and one Linux container.
- The container runs OpenBot's computer service from a pinned source revision.
- The Worker authenticates provider lifecycle calls separately from per-Dot computer actions.
- Explicit stop and idle timeout snapshot the writable filesystem before stopping compute.
- The next start restores the snapshot. A 25-day alarm refreshes dormant snapshot retention before Cloudflare's documented 30-day expiry.

Cloudflare Containers are not available on Workers Free. The minimum is Workers Paid at $5/month plus usage-based charges. The selected standard-1 instance uses 4 GiB RAM, 0.5 vCPU, and 8 GB disk. Check the linked pricing docs before provisioning.

See docs/CLOUDFLARE_COMPUTERS.md for setup, billing, security, and the live-qualification process.
