# Cloudflare API-first deployment

This is the first Cloudflare deployment slice for OpenDots. It adds a Workers API, D1-backed persistent memory/settings/research records, and a durable Workflow for web research. It deliberately does **not** claim that the current Node.js application has been fully migrated to Workers.

## What runs in this slice

- Cloudflare Worker API protected by an `OWNER_TOKEN` bearer token.
- D1 tables for settings, memories, and research runs.
- Parallel's existing MCP web-search/fetch provider, reused from `src/server/parallel.ts`.
- Optional synthesis using an OpenAI-compatible chat-completions API.
- Cloudflare Workflow steps for searching, persisting sources, synthesis, and status/error persistence.
- Durable research records live in D1. Workflow execution history is not the source of truth.

Endpoints:

| Method     | Endpoint            | Purpose                                                             |
| ---------- | ------------------- | ------------------------------------------------------------------- |
| GET        | `/api/health`       | Unauthenticated health/config check (does not reveal secrets).      |
| GET/PATCH  | `/api/settings`     | Read or change the name, pause, research and memory switches.       |
| GET/POST   | `/api/memories`     | List or add a memory.                                               |
| PUT/DELETE | `/api/memories/:id` | Edit or delete a memory.                                            |
| POST       | `/api/research`     | Enqueue a durable research workflow; returns HTTP 202 and a run ID. |
| GET        | `/api/research`     | List the most recent 50 research runs.                              |
| GET        | `/api/research/:id` | Read a run's status, sources, result and safe error message.        |

For search-only runs, set `synthesize: false`. For a synthesized answer, configure `OPENAI_API_KEY` and `OPENAI_MODEL`. `PARALLEL_API_KEY` is optional if the provider still permits anonymous/light use for your account; configure it for authenticated usage.

## Important current limitations

- This is an **API foundation, not the complete OpenDots app on Cloudflare yet**. The existing React UI is not wired to this API slice, and routes for Spaces, specialist Dots, CopilotKit conversations/streaming, voice, Slack channels, approvals, and the current task/runner model still require ports/adapters.
- The existing `src/server/index.ts` cannot simply be deployed as a Worker: `Store` and `WorkspaceStore` use `node:sqlite` and filesystem-backed initialization. Workers must use D1 through the binding instead of relying on that local database. The Docker supervisor, Chromium service, browser profiles and shell are also outside this Worker.
- Do not point the current SPA at this API until the UI/API compatibility pass is complete. The current Docker Compose deployment remains unchanged.
- Research uses a model API for synthesis and an external web-search provider. Cloudflare provides compute/orchestration and durable application data; it does not make those provider APIs free.
- On the free Workers plan, request, CPU, D1 and Workflow quotas apply. Workflow execution history is retained for three days on the free plan; research status/result is separately retained in D1.
- The `database_id` in `cloudflare/wrangler.jsonc` is deliberately a local placeholder. Replace it with the ID returned by `wrangler d1 create` before deploying to Cloudflare.

## Local development

Requirements: Node.js 24 and npm (same baseline as the main project). Wrangler is invoked with `npx` so this change does not silently alter the existing lockfile.

1. Install the existing dependencies:

   ```sh
   npm ci
   ```

2. Copy the local secret template and set a long random owner token. Fill in API keys if using provider-authenticated search and synthesis:

   ```sh
   cp cloudflare/.dev.vars.example cloudflare/.dev.vars
   ```

3. Start Wrangler locally. The first run creates local D1 state in Wrangler's local persistence directory:

   ```sh
   npm run cf:dev
   ```

4. Apply the migration to the local D1 database if needed:

   ```sh
   npm run cf:migrate:local
   ```

5. Check health:

   ```sh
   curl http://127.0.0.1:8787/api/health
   ```

6. Test a search-only research run:

   ```sh
   curl -X POST http://127.0.0.1:8787/api/research \
     -H "Authorization: Bearer YOUR_OWNER_TOKEN" \
     -H "Content-Type: application/json" \
     -d '{"objective":"Find the official Cloudflare Workers free plan limits","synthesize":false}'
   ```

   Poll the returned `statusUrl` with the same Authorization header until the status is `completed` or `failed`.

## Create and deploy Cloudflare resources

Authenticate Wrangler using your Cloudflare account in a browser:

```sh
npx --yes wrangler login
npx --yes wrangler d1 create opendots-db --config cloudflare/wrangler.jsonc --update-config
```

Review `cloudflare/wrangler.jsonc` and confirm the database ID was updated. Then apply the D1 schema remotely:

```sh
npm run cf:migrate:remote
```

Set secrets using Wrangler (values are entered interactively; do not commit them):

```sh
npx --yes wrangler secret put OWNER_TOKEN --config cloudflare/wrangler.jsonc
npx --yes wrangler secret put PARALLEL_API_KEY --config cloudflare/wrangler.jsonc
npx --yes wrangler secret put OPENAI_API_KEY --config cloudflare/wrangler.jsonc
npx --yes wrangler secret put OPENAI_MODEL --config cloudflare/wrangler.jsonc
# Optional only when using a non-default provider endpoint:
npx --yes wrangler secret put OPENAI_BASE_URL --config cloudflare/wrangler.jsonc
```

Deploy:

```sh
npm run cf:deploy
```

Do not set `OPENAI_BASE_URL` as a secret unless you need to override the default; a regular Worker variable is sufficient for non-sensitive configuration. The model name is not usually secret either, but the documented commands use secrets uniformly to avoid exposing values in repository configuration.

## Local API verification

Health endpoint:

```sh
curl -i http://127.0.0.1:8787/api/health
```

Add memory:

```sh
curl -X POST http://127.0.0.1:8787/api/memories \
  -H "Authorization: Bearer YOUR_OWNER_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"text":"Use official primary sources for infrastructure research."}'
```

List research runs:

```sh
curl http://127.0.0.1:8787/api/research \
  -H "Authorization: Bearer YOUR_OWNER_TOKEN"
```

## Follow-up milestones

1. Run Wrangler's local type/bundle and migration checks, then exercise health, memory CRUD, a search-only Workflow, synthesis, retry/failure handling, and D1 persistence across restarts.
2. Port the current `Store`/workspace schema and APIs to D1 behind a storage interface.
3. Port or replace the CopilotKit runtime and connect the UI to the Worker endpoints.
4. Add an appropriate computer-provider adapter only if product tasks still require real browser/terminal interaction. Do not expose a Docker socket from a Worker.
