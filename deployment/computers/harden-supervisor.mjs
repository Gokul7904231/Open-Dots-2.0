import { readFile, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

// Fail closed when the exact pinned upstream contract changes. We patch only
// child authentication and the two narrowly-scoped backup routes.
export function hardenSupervisorEnvironment(source) {
  const before = "const computerToken = env.COMPUTER_TOKEN?.trim() || undefined;";
  if (source.split(before).length !== 2) {
    throw new Error("Pinned OpenBot environment contract changed; review before building.");
  }
  return "import { createHmac } from \"node:crypto\";\n" + source.replace(
    before,
    "const master = env.COMPUTER_TOKEN?.trim();\n" +
      "  if (!master || master.length < 24) throw new Error(\"COMPUTER_TOKEN must contain at least 24 characters.\");\n" +
      "  const computerToken = createHmac(\"sha256\", master).update(\"opendots-computer:\" + botId).digest(\"hex\");",
  );
}

export function hardenSupervisorIndex(source) {
  const importAnchor = 'import { listenPort } from "./listen-port";';
  const serveAnchor = "serve({ port, fetch: app.fetch, idleTimeout: 120 });";
  if (source.split(importAnchor).length !== 2) {
    throw new Error("Pinned OpenBot index import contract changed; review before building.");
  }
  if (source.split(serveAnchor).length !== 2) {
    throw new Error("Pinned OpenBot server-start contract changed; review before building.");
  }
  let next = source.replace(
    importAnchor,
    importAnchor + '\nimport { attachBackupRoutes, isBackupLocked } from "./b2-archive-supervisor.mjs";',
  );

  const guardedActions = [
    {
      action: "ensure",
      anchor: '  if (!parsed.ok) return context.json({ error: parsed.reason }, 400);\n\n  try {',
    },
    {
      action: "stop",
      anchor: '  if (!parsed.ok) return context.json({ error: parsed.reason }, 400);\n  try {\n    const stopped = await stop(parsed.names);',
    },
    {
      action: "reset",
      anchor: '  if (!parsed.ok) return context.json({ error: parsed.reason }, 400);\n  try {\n    const wasThere = await reset(parsed.names);',
    },
  ];
  for (const item of guardedActions) {
    if (next.split(item.anchor).length !== 2) {
      throw new Error("Pinned OpenBot " + item.action + " route contract changed; review before building.");
    }
    const insertion = item.action === "ensure"
      ? '  if (isBackupLocked(parsed.names.botId)) return context.json({ error: "Computer is being backed up or restored." }, 409);\n\n  try {'
      : item.action === "stop"
        ? '  if (isBackupLocked(parsed.names.botId)) return context.json({ error: "Computer is being backed up or restored." }, 409);\n  try {\n    const stopped = await stop(parsed.names);'
        : '  if (isBackupLocked(parsed.names.botId)) return context.json({ error: "Computer is being backed up or restored." }, 409);\n  try {\n    const wasThere = await reset(parsed.names);';
    next = next.replace(item.anchor, insertion);
  }

  const attachAnchor = '  serveAnchor';
  return next.replace(
    serveAnchor,
    "attachBackupRoutes(app, resolve);\n\n" + serveAnchor,
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const environmentPath = process.argv[2];
  const indexPath = process.argv[3];
  if (!environmentPath || !indexPath) {
    throw new Error("Pass both the pinned supervisor environment.ts and index.ts paths.");
  }
  const environment = await hardenSupervisorEnvironment(await readFile(environmentPath, "utf8"));
  const index = await hardenSupervisorIndex(await readFile(indexPath, "utf8"));
  await writeFile(environmentPath, environment);
  await writeFile(indexPath, index);
}
