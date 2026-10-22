# A computer for each Dot

OpenDots connects each specialist to its own container through [OpenBot](https://github.com/CopilotKit/OpenBot)'s computer service and supervisor. A Dot's ID determines its computer and persistent volumes. Files and browser profiles survive stop/start; they are separate from Spaces pages and CopilotKit conversation history.

The app exposes selected computer tools to the same Dot agent used by web chat, Slack, scheduled work, and voice's compute delegation. Browser, workspace-file, and shell permissions are saved per Dot and checked by the server. They start disabled. No action falls back to your host's shell or files when the computer service is unavailable.

## Provider architecture

OpenDots separates its computer API from the infrastructure used to provision computers. Set `COMPUTER_PROVIDER=docker-supervisor` to use the current OpenBot supervisor and Docker Engine adapter. The provider contract lives in `src/server/computer-provider.ts`; adapters and provider selection live in `src/server/docker-supervisor-provider.ts` and `src/server/computer-provider-factory.ts`.

See [Computer Provider Contract](COMPUTER_PROVIDERS.md) for the provider requirements. The local Docker adapter remains the development default. The experimental Cloudflare Containers adapter is the chosen remote target; it needs a separately deployed Worker, the matching server/Worker secrets, and a successful live qualification run before production use. Provider selection alone is not evidence that the runtime is configured or qualified.

## Use the Cloudflare computer runtime

Follow [Cloudflare Computer Setup](CLOUDFLARE_COMPUTERS.md) to deploy the dedicated Worker and configure the OpenDots server. Select `COMPUTER_PROVIDER=cloudflare-containers` only after the Worker is deployed. Cloudflare Containers require the Workers Paid plan and usage charges; this is not a Workers Free-tier computer. Run `npm run qualify:computer` against the actual deployed OpenDots app before relying on the provider.

## Use the Vercel Sandbox computer runtime

Select `COMPUTER_PROVIDER=vercel-sandbox` to run each Dot's computer inside an isolated Linux MicroVM using the official `@vercel/sandbox` SDK. See [Computer Provider Contract](COMPUTER_PROVIDERS.md) for configuration and snapshot lifecycle details, and [Live Computer Qualification](COMPUTER_QUALIFICATION.md) for qualification procedures.

## Start services for local development

Use a working Docker Engine with Compose v2 and BuildKit support for additional build contexts. Keep the application on Node.js 24 as described in [Setup](SETUP.md). Add two different random secrets of at least 24 characters to `.env` and set:

```dotenv
COMPUTER_SUPERVISOR_URL=http://127.0.0.1:4312
COMPUTER_SUPERVISOR_TOKEN=REPLACE_WITH_A_RANDOM_SECRET
COMPUTER_TOKEN=REPLACE_WITH_A_DIFFERENT_RANDOM_SECRET
COMPUTER_NAMESPACE=opendots
```

Do not use the placeholder values. The supervisor token authorizes lifecycle requests. The computer token is a master used to derive a different credential for each Dot; the master stays in the application and supervisor.

Build both images before starting the supervisor:

```sh
docker compose -f compose.computers.yml build computer-image computer-supervisor
docker compose -f compose.computers.yml up -d computer-supervisor
npm run dev
```

The computer-image service is a build target, not a shared computer to run. The supervisor creates a container when you start a Dot's computer. In this local arrangement, each computer publishes a dynamic loopback port for the app to reach. Port 4312 is the loopback supervisor endpoint. The local control network uses a normal bridge so Docker can publish that port. The container-app overlay makes the control network internal and removes the host port; the app then connects through service DNS.

Open a Dot's **Computer** panel, enable computer access and the capabilities you want, then choose **Start**. Check its status, navigate to a page, and refresh its screen. Only grant shell access when that Dot needs to run commands.

## Run the application in containers

Configure the existing `OWNER_TOKEN` and `BROWSER_SECRET` as well as the computer secrets. Use the overlay that connects the app to the supervisor and computer network:

```sh
docker compose -f compose.yml -f compose.computers.yml -f compose.computers-app.yml build computer-image computer-supervisor app browser
docker compose -f compose.yml -f compose.computers.yml -f compose.computers-app.yml up -d app browser computer-supervisor
```

Here, the app addresses computers by their container names. Computers have no published host ports. The supervisor lives on a separate control network, and only the supervisor mounts the Docker socket. Neither the web app nor a Dot's computer receives that socket. Changing the namespace changes which containers and volumes are selected; keep it stable and unique for each deployment.

## Use the computer

- **Browser:** navigate and inspect the current page, including screenshots and element snapshots. Browser profiles keep cookies and logins across container restarts.
- **Take control:** pause agent input while you click, type, scroll, or press keys in the browser. Release control when done. The agent must obtain a fresh snapshot before resuming element actions.
- **Files:** list, read, and write text files in the Dot's workspace. Paths must stay relative to that workspace. These files are not automatically added to Spaces pages.
- **Terminal:** run a bounded command inside that Dot's container when shell access is enabled. Command output is displayed; execution does not run on the OpenDots host.
- **Activity:** inspect action names, who requested them, and success/failure. The audit record deliberately excludes typed values, file contents, and full commands.

Stop retains files and browser profiles. The app does not expose a destructive reset action. Stopping the supervisor does not stop its dynamically created computers; stop each Dot's computer first if you want them all offline. Compose does not own those dynamically created containers or volumes. Do not delete named workspace/profile volumes as routine cleanup.

Revoking a capability cancels the application's active request and prevents subsequent actions. Cancellation cannot undo completed side effects, and an upstream browser operation may finish after the request is cancelled. Stop the computer when you need to end all activity in its container. Activity retains the latest 1,000 completed records per Dot, plus pending requests.

The template uses standard Docker container isolation; containers share the host kernel. Shell access permits programs and network access inside the container and can read that Dot's own browser profile. Run this on infrastructure appropriate for that trust level. `COMPUTER_RUNTIME=runsc` can select an already-installed gVisor runtime; the template does not install it or claim stronger isolation by default. It does not configure a restrictive network-egress policy.

## Live qualification

Run the live lifecycle proof against the currently configured provider with `npm run qualify:computer`. It tests real HTTPS browser navigation, workspace writes, a provider stop/start, workspace persistence, and (by default) an HTTPS cookie across restart. Read [Live Computer Qualification](COMPUTER_QUALIFICATION.md) for prerequisites and safe cleanup behavior.

This is a runtime qualification tool, not an uptime/free-tier guarantee. It only proves the exact provider configuration and resources that were tested.

## Verify and troubleshoot

Create two Dots and enable the capabilities being tested. Write a file in the first computer, then verify that the second cannot list it. Stop/start the first and verify the file persists. Test a browser session across a restart, takeover and handback, disabled permissions, and pause behavior. Confirm that computer tools fail clearly if the service is unavailable.

A configured endpoint is not evidence that Docker successfully provisioned a computer. An unavailable status can mean the Docker daemon is down, the image was not built, credentials differ, or the app cannot reach the returned computer address. Use the local arrangement for a host-run app and the app overlay for a container-run app. Do not substitute an arbitrary returned service URL or expose the computer API directly to the internet.

The source revision and the narrow per-Dot credential patch are documented in [deployment/computers](../deployment/computers/README.md). On a master-token or image change, the supervisor replaces owned computer containers on their next ensure request, retaining their profile and workspace volumes. This ends any in-flight activity; coordinate updates with active work.

Automated tests use controlled service fixtures for policy, request, and lifecycle behavior. Live Docker, model, Slack, and voice checks must be recorded separately from those tests.
