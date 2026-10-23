import { readFile, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

// Fail closed when the exact pinned upstream contract changes. We patch child
// authentication and wire in the two backup routes plus their lifecycle lock.
// Replacements use functions so no `$` sequence in a replacement is interpreted.
function replaceOnce(source, anchor, replacement, message) {
  if (source.split(anchor).length !== 2) throw new Error(message);
  return source.replace(anchor, () => replacement);
}

export function hardenSupervisorEnvironment(source) {
  const before =
    'const computerToken = env.COMPUTER_TOKEN?.trim() || undefined;';
  const patched = replaceOnce(
    source,
    before,
    'const master = env.COMPUTER_TOKEN?.trim();\n' +
      '  if (!master || master.length < 24) throw new Error("COMPUTER_TOKEN must contain at least 24 characters.");\n' +
      '  const computerToken = createHmac("sha256", master).update("opendots-computer:" + botId).digest("hex");',
    'Pinned OpenBot environment contract changed; review before building.',
  );
  return 'import { createHmac } from "node:crypto";\n' + patched;
}

// Bun.serve rejects request bodies above 128 MiB by default and closes idle
// connections after the configured seconds (255 is Bun's maximum). Backups can reach
// the archive limit, and building one produces no bytes until it is complete.
const SERVE_OPTIONS = 'idleTimeout: 255, maxRequestBodySize: 600 * 1024 * 1024';

export function hardenSupervisorIndex(source) {
  const importAnchor = 'import { listenPort } from "./listen-port";';
  const healthAnchor = 'app.get("/health", async (context) =>';
  const serveAnchor = 'serve({ port, fetch: app.fetch, idleTimeout: 120 });';

  let next = replaceOnce(
    source,
    importAnchor,
    importAnchor +
      '\nimport { attachBackupRoutes, lifecycleGuard } from "./b2-archive-supervisor.mjs";',
    'Pinned OpenBot index import contract changed; review before building.',
  );
  // After the authentication middleware and before any route, so the guard never
  // sees an unauthenticated request and every lifecycle verb passes through it.
  next = replaceOnce(
    next,
    healthAnchor,
    'app.use("*", lifecycleGuard);\n\n' + healthAnchor,
    'Pinned OpenBot health route contract changed; review before building.',
  );
  return replaceOnce(
    next,
    serveAnchor,
    'attachBackupRoutes(app, resolve);\n\n' +
      'serve({ port, fetch: app.fetch, ' +
      SERVE_OPTIONS +
      ' });',
    'Pinned OpenBot server-start contract changed; review before building.',
  );
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const environmentPath = process.argv[2];
  const indexPath = process.argv[3];
  if (!environmentPath || !indexPath) {
    throw new Error(
      'Pass both the pinned supervisor environment.ts and index.ts paths.',
    );
  }
  const environment = hardenSupervisorEnvironment(
    await readFile(environmentPath, 'utf8'),
  );
  const index = hardenSupervisorIndex(await readFile(indexPath, 'utf8'));
  await writeFile(environmentPath, environment);
  await writeFile(indexPath, index);
}
