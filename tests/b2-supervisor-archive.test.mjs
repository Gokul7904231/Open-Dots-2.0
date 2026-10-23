import { describe, expect, it } from "vitest";
import {
  createTarArchive,
  decodeOdar,
  encodeOdar,
  parseTarArchive,
  safeArchivePath,
} from "../deployment/computers/b2-archive-format.mjs";
import {
  hardenSupervisorEnvironment,
  hardenSupervisorIndex,
} from "../deployment/computers/harden-supervisor.mjs";

describe("supervisor archive format", () => {
  it("round-trips binary workspace files through ODAR", () => {
    const expected = Buffer.from([0, 1, 2, 127, 128, 254, 255]);
    const packed = encodeOdar("workspace", [
      { path: "src/binary.bin", data: expected, mtime: 1_700_000_000 },
    ]);
    const decoded = decodeOdar(packed, "workspace");
    expect(decoded).toHaveLength(1);
    expect(decoded[0].path).toBe("src/binary.bin");
    expect(decoded[0].data).toEqual(expected);
    expect(decoded[0].mtime).toBe(1_700_000_000);
  });

  it("round-trips tar files, including paths that require a PAX header", () => {
    const data = Buffer.from([0, 9, 10, 13, 127, 255]);
    const longPath = "x".repeat(130);
    const tar = createTarArchive([
      { path: "workspace/marker.bin", data, mtime: 1_700_000_000 },
      { path: longPath, data: Buffer.from("long path") },
    ]);
    const decoded = parseTarArchive(tar, "/workspace", "workspace");
    expect(decoded.map((entry) => entry.path)).toEqual(["marker.bin", longPath]);
    expect(decoded[0].data).toEqual(data);
    expect(decoded[1].data.toString("utf8")).toBe("long path");
  });

  it("rejects traversal, absolute paths, and reserved staging names", () => {
    expect(() => safeArchivePath("../escape")).toThrow();
    expect(() => safeArchivePath("/absolute/path")).toThrow();
    expect(() => safeArchivePath("C:/Windows/file")).toThrow();
    expect(() => safeArchivePath(".opendots-b2-rollback-x/file")).toThrow();
  });

  it("fails closed if the pinned supervisor environment contract changes", () => {
    expect(() => hardenSupervisorEnvironment("const different = true;")).toThrow(
      /contract changed/,
    );
  });

  it("patches the pinned supervisor index with authenticated backup routes", () => {
    const source = [
      'import { listenPort } from "./listen-port";',
      'serve({ port, fetch: app.fetch, idleTimeout: 120 });',
    ].join("\n");
    const patched = hardenSupervisorIndex(source);
    expect(patched).toContain('import { attachBackupRoutes } from "./b2-archive-supervisor.mjs";');
    expect(patched).toContain("attachBackupRoutes(app, resolve);");
  });

  it("fails closed if the pinned supervisor index contract changes", () => {
    expect(() => hardenSupervisorIndex("serve(app);")).toThrow(/contract changed/);
  });
});
