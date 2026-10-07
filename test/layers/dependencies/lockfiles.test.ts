import { describe, expect, it } from "vitest";
import { createLineLocator, type Declaration } from "../../../src/layers/dependencies/declaration.js";
import type { LockedVersion } from "../../../src/layers/dependencies/lockfile.js";
import { readNugetLock } from "../../../src/layers/dependencies/read-nuget-lock.js";
import { readPackageLock } from "../../../src/layers/dependencies/read-package-lock.js";
import { readPnpmLock } from "../../../src/layers/dependencies/read-pnpm-lock.js";
import { preferResolved } from "../../../src/layers/dependencies/resolve-lockfiles.js";

const isWatched = (name: string) => name === "amqplib" || name === "@softure/broker";
const show = (locked: LockedVersion | undefined) =>
  locked === undefined ? "none" : `${locked.name}@${locked.version}:${locked.line}`;
const lines = (...text: string[]) => text.join("\n");

function unwrap<T>(result: { ok: true; value: T } | { ok: false; error: string }): T {
  if (!result.ok) throw new Error(result.error);
  return result.value;
}

describe("createLineLocator", () => {
  it("maps offsets to 1-based lines, including the first and last offset", () => {
    const toLine = createLineLocator("a\nbc\n\nd");
    expect([0, 1, 2, 4, 5, 6].map(toLine)).toEqual([1, 1, 2, 2, 3, 4]);
  });
});

describe("readPackageLock", () => {
  const v3 = lines(
    "{",
    '  "name": "app",',
    '  "lockfileVersion": 3,',
    '  "packages": {',
    '    "": { "name": "app", "workspaces": ["apps/web"], "dependencies": { "express": "^4.1.0" } },',
    '    "apps/web": { "name": "web", "dependencies": { "express": "^4.0.0", "zod": "^3.0.0" } },',
    '    "apps/web/node_modules/express": {',
    '      "version": "4.0.0"',
    "    },",
    '    "node_modules/express": {',
    '      "version": "4.9.0"',
    "    },",
    '    "node_modules/web": {',
    '      "resolved": "apps/web",',
    '      "link": true',
    "    },",
    '    "node_modules/wrapper/node_modules/amqplib": {',
    '      "version": "0.10.4"',
    "    },",
    '    "node_modules/amqplib": {',
    '      "version": "0.8.0"',
    "    }",
    "  }",
    "}",
  );

  it("resolves direct dependencies by node resolution from the importer folder", () => {
    const lockfile = unwrap(readPackageLock(v3, "package-lock.json", isWatched));
    expect(show(lockfile.resolveDirect("", "express"))).toBe("express@4.9.0:10");
    expect(show(lockfile.resolveDirect("apps/web", "express"))).toBe("express@4.0.0:7");
    expect(show(lockfile.resolveDirect("apps/web", "zod"))).toBe("none");
    expect(show(lockfile.resolveDirect("", "web"))).toBe("none");
    expect([
      lockfile.hasImporter(""),
      lockfile.hasImporter("apps/web"),
      lockfile.hasImporter("tools"),
    ]).toEqual([true, true, false]);
  });

  it("lists every installed copy of a watched package", () => {
    const lockfile = unwrap(readPackageLock(v3, "package-lock.json", isWatched));
    expect(lockfile.watched.map(show)).toEqual(["amqplib@0.10.4:17", "amqplib@0.8.0:20"]);
  });

  it("reads lockfile version 1 for the root project only", () => {
    const v1 = lines(
      "{",
      '  "lockfileVersion": 1,',
      '  "dependencies": {',
      '    "express": {',
      '      "version": "4.9.0",',
      '      "dependencies": { "amqplib": { "version": "0.10.4" } }',
      "    }",
      "  }",
      "}",
    );
    const lockfile = unwrap(readPackageLock(v1, "package-lock.json", isWatched));
    expect(show(lockfile.resolveDirect("", "express"))).toBe("express@4.9.0:4");
    expect(lockfile.hasImporter("apps/web")).toBe(false);
    expect(lockfile.watched.map(show)).toEqual(["amqplib@0.10.4:6"]);
  });

  it("fails on an unknown lockfile version and on invalid JSON", () => {
    expect(readPackageLock('{ "lockfileVersion": 4 }', "package-lock.json", isWatched)).toEqual({
      ok: false,
      error: "package-lock.json: lockfileVersion 4 is not supported (supported: 1, 2, 3)",
    });
    const invalid = readPackageLock("{", "package-lock.json", isWatched);
    expect(invalid.ok).toBe(false);
    expect(invalid.ok ? "" : invalid.error).toContain("package-lock.json is not valid JSON");
  });
});

describe("readPnpmLock", () => {
  it("reads lockfile 9.x importers, strips peer suffixes and skips workspace links", () => {
    const text = lines(
      "lockfileVersion: '9.0'",
      "",
      "settings:",
      "  autoInstallPeers: true",
      "",
      "importers:",
      "",
      "  .:",
      "    dependencies:",
      "      '@softure/broker':",
      "        specifier: ^1.0.0",
      "        version: 1.4.0(react@18.2.0)",
      "      shared:",
      "        specifier: workspace:*",
      "        version: link:packages/shared",
      "",
      "  apps/web:",
      "    devDependencies:",
      "      zod:",
      "        specifier: ^3.0.0",
      "        version: 3.23.8",
      "",
      "packages:",
      "",
      "  '@softure/broker@1.4.0':",
      "    resolution: {integrity: sha512-x}",
      "",
      "  amqplib@0.10.4:",
      "    resolution: {integrity: sha512-y}",
      "",
      "snapshots:",
      "",
      "  amqplib@0.10.4:",
      "    dependencies:",
      "      zod: 3.23.8",
    );
    const lockfile = unwrap(readPnpmLock(text, "pnpm-lock.yaml", isWatched));
    expect(show(lockfile.resolveDirect("", "@softure/broker"))).toBe("@softure/broker@1.4.0:12");
    expect(show(lockfile.resolveDirect("", "shared"))).toBe("none");
    expect(show(lockfile.resolveDirect("apps/web", "zod"))).toBe("zod@3.23.8:21");
    expect([lockfile.hasImporter("apps/web"), lockfile.hasImporter("apps/api")]).toEqual([true, false]);
    expect(lockfile.watched.map(show)).toEqual(["@softure/broker@1.4.0:25", "amqplib@0.10.4:28"]);
  });

  it("reads lockfile 6.x with root sections and slash-prefixed package keys", () => {
    const text = lines(
      "lockfileVersion: '6.0'",
      "",
      "dependencies:",
      "  express:",
      "    specifier: ^4.1.0",
      "    version: 4.9.0",
      "",
      "packages:",
      "",
      "  /amqplib@0.10.4(supports-color@5.5.0):",
      "    resolution: {integrity: sha512-y}",
      "    dev: false",
    );
    const lockfile = unwrap(readPnpmLock(text, "pnpm-lock.yaml", isWatched));
    expect(show(lockfile.resolveDirect("", "express"))).toBe("express@4.9.0:6");
    expect(lockfile.hasImporter("")).toBe(true);
    expect(lockfile.watched.map(show)).toEqual(["amqplib@0.10.4:10"]);
  });

  it("reads lockfile 5.x scalar versions and slash-separated package keys", () => {
    const text = lines(
      "lockfileVersion: 5.4",
      "",
      "specifiers:",
      "  express: ^4.1.0",
      "",
      "dependencies:",
      "  express: 4.9.0_supports-color@5.5.0",
      "",
      "packages:",
      "",
      "  /amqplib/0.10.4:",
      "    resolution: {integrity: sha512-y}",
    );
    const lockfile = unwrap(readPnpmLock(text, "pnpm-lock.yaml", isWatched));
    expect(show(lockfile.resolveDirect("", "express"))).toBe("express@4.9.0:7");
    expect(lockfile.watched.map(show)).toEqual(["amqplib@0.10.4:11"]);
  });

  it("fails on an unknown lockfile version and on a file without one", () => {
    expect(readPnpmLock("lockfileVersion: '10.0'\n", "pnpm-lock.yaml", isWatched)).toEqual({
      ok: false,
      error: "pnpm-lock.yaml: lockfileVersion '10.0' is not supported (supported: 5.x, 6.x, 9.x)",
    });
    expect(readPnpmLock("importers: {}\n", "pnpm-lock.yaml", isWatched)).toEqual({
      ok: false,
      error: "pnpm-lock.yaml: no lockfileVersion; not a pnpm lockfile",
    });
  });
});

describe("readNugetLock", () => {
  const text = lines(
    "{",
    '  "version": 2,',
    '  "dependencies": {',
    '    "net8.0": {',
    '      "Npgsql": {',
    '        "type": "Direct",',
    '        "requested": "[8.0.0, )",',
    '        "resolved": "8.0.3",',
    '        "dependencies": { "Microsoft.Extensions.Logging.Abstractions": "8.0.0" }',
    "      },",
    '      "amqplib": {',
    '        "type": "CentralTransitive",',
    '        "requested": "[0.10.0, )",',
    '        "resolved": "0.10.4"',
    "      },",
    '      "Microsoft.Extensions.Logging.Abstractions": {',
    '        "type": "Transitive",',
    '        "resolved": "8.0.0"',
    "      },",
    '      "Petseo.Domain": { "type": "Project" }',
    "    }",
    "  }",
    "}",
  );

  it("returns direct entries and watched transitive entries only", () => {
    const lockfile = unwrap(readNugetLock(text, "src/Api/packages.lock.json", isWatched));
    expect(lockfile.direct.map(show)).toEqual(["Npgsql@8.0.3:5"]);
    expect(lockfile.watched.map(show)).toEqual(["amqplib@0.10.4:11"]);
  });

  it("fails on an unknown version", () => {
    expect(readNugetLock('{ "version": 3, "dependencies": {} }', "packages.lock.json", isWatched)).toEqual({
      ok: false,
      error: "packages.lock.json: version 3 is not supported (supported: 1, 2)",
    });
  });
});

describe("preferResolved", () => {
  const declaration = (name: string, version: string, resolution?: "lockfile"): Declaration => ({
    ecosystem: "nuget",
    name,
    version,
    path: resolution === undefined ? "Directory.Packages.props" : "packages.lock.json",
    line: 1,
    ...(resolution === undefined ? {} : { resolution }),
  });

  it("drops declared versions of packages a lockfile resolved, case-insensitively for NuGet", () => {
    const kept = preferResolved(
      [declaration("Npgsql", "8.0.0"), declaration("Polly", "8.4.0")],
      [declaration("npgsql", "8.0.3", "lockfile")],
    );
    expect(kept.map((d) => `${d.name}@${d.version}`)).toEqual(["Polly@8.4.0", "npgsql@8.0.3"]);
  });
});
