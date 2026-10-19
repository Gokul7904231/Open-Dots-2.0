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

## Current boundary and known scope

The Docker adapter is the only registered provider in this change. The contract is designed to accept remote HTTPS endpoints, but no remote provider adapter has been implemented or qualified yet. The computer action protocol and per-Dot credential derivation are unchanged.


## Experimental Daytona provider

The Daytona adapter is a **qualification candidate**, not a declaration that Daytona is permanently free or production-qualified. Daytona usage is billed against the account's applicable compute/storage allowance and rates; a promotional credit balance is not an always-free guarantee. Check the account's current billing and quotas before provisioning. The repository does not hold or need a Daytona API key.

To try it:

1. Generate a Daytona API key and set it as `DAYTONA_API_KEY` only in the server's secret environment.
2. Set `COMPUTER_PROVIDER=daytona`, and retain a strong `COMPUTER_TOKEN` (24+ random characters). Do not set `COMPUTER_SUPERVISOR_TOKEN` for this provider.
3. Adjust the Daytona CPU/memory/disk settings only after checking their current cost and free credits.
4. Start one test Dot and run `npm run qualify:computer` against the actual deployed OpenDots API. The test intentionally uses a real external page and verifies workspace and browser-profile persistence across a provider stop/start.
5. Keep shell access disabled unless the Dot specifically needs it. Review sandbox usage and delete the candidate after testing if you do not intend to keep paying for its disk.

The adapter creates one Daytona sandbox per Dot, builds the pinned OpenBot computer runtime, keeps the sandbox private, and calls its computer through a short-lived, port-scoped signed preview URL. It does not forward the Daytona API key into the sandbox. The sandbox receives only the Dot-specific HMAC computer token expected by OpenDots. Daytona's own sandbox tool API key and signed-preview mechanism remain provider dependencies.

The first sandbox for a Dot builds the browser runtime and can take several minutes and consume meaningful credits. The default resource request is 1 CPU, 2 GiB memory, and 8 GiB disk; tune `DAYTONA_COMPUTER_CPU`, `DAYTONA_COMPUTER_MEMORY_GIB`, and `DAYTONA_COMPUTER_DISK_GIB` within the provider's supported limits. `autoStopInterval=0` disables Daytona's inactivity stop, so explicitly stop computers when they are not needed. Daytona's sandbox persistence is not a promise of unlimited retention, zero cost, or guaranteed availability.

**Not yet live-qualified:** this adapter is validated by deterministic tests only until it has been run with your own Daytona API key against a real sandbox. Passing repository CI does not satisfy the live qualification gate.
