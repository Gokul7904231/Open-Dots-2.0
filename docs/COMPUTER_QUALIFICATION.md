# Live Computer Qualification

This runbook tests a real running OpenDots deployment—not a mock provider fixture.

## What it proves

The command makes authenticated requests through the same public OpenDots computer routes used by the app. It selects one Dot, temporarily enables browser/files only (shell remains disabled), provisions the computer, visits a real HTTPS page, writes a per-Dot workspace marker, and stops/starts the computer. After restart it verifies the file. By default it also sets a unique HTTPS cookie on `httpbin.org` and verifies that the cookie survives the restart, which is a real browser-profile persistence check.

A pass qualifies the currently selected provider for this tested one-Dot lifecycle. It does **not** establish that the provider is permanently free, accepts Indian registrations without a card, guarantees always-on uptime, or provides any SLA. Record those hosting gates separately.

## Prerequisites

- OpenDots is deployed and reachable at its root URL.
- `OWNER_TOKEN` is configured and available in `.env` or the process environment.
- A provider is configured and the computer image/runtime has been prepared. The current default is `docker-supervisor`.
- At least one Dot exists. If there are multiple Dots, set `DOT_ID` to the one you intend to test.
- The test requires public HTTPS access to `example.com`; the default browser-profile proof also requires `httpbin.org` access.

## Run it

From the repository root:

```sh
npm run qualify:computer
```

For a remotely hosted app:

```sh
OPENDOTS_BASE_URL=https://your-opendots-host.example npm run qualify:computer
```

Use environment variables; never put credentials in the command line or paste them into chat. The script reads `OWNER_TOKEN` from `.env` through Node's `--env-file-if-exists` option, while already-exported environment variables take precedence.

If the selected Dot is already running, the script refuses to interrupt it unless you explicitly allow the restart test:

```sh
COMPUTER_QUALIFY_ALLOW_RESTART=1 npm run qualify:computer
```

Set `COMPUTER_QUALIFY_KEEP_RUNNING=1` only when you want the script to leave the computer running with browser/files permissions enabled and shell disabled. Otherwise the script stops computers it started and restores the Dot's original permissions. The small file `opendots-qualification/proof.txt` is intentionally retained to make workspace persistence verifiable in later runs.

If outbound access to `httpbin.org` is blocked, you may disable only the cookie probe with `COMPUTER_QUALIFY_COOKIE_PROBE=0`; the report will then **not** qualify browser-profile persistence. Configure `COMPUTER_QUALIFY_TIMEOUT_MS` to change the per-request deadline (1000–300000 ms).

## Expected checks

1. Provider reports a running computer.
2. Browser navigates to `https://example.com/` and reads “Example Domain”.
3. A workspace file can be written and read.
4. Provider stops and restarts the Dot computer.
5. Workspace proof data survives stop/start.
6. Unless disabled, a unique browser cookie survives stop/start.

The test never enables shell execution, exposes a provider endpoint, or logs owner/provider tokens.
