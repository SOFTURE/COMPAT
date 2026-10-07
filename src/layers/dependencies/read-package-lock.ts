import { err, ok, type Result } from "../../result.js";
import { createLineLocator } from "./declaration.js";
import { findObjectKeys, isRecord, type LockedVersion, type NpmLockfile, parseJson } from "./lockfile.js";

const NODE_MODULES = "node_modules/";

function getParentFolder(folder: string): string {
  const slash = folder.lastIndexOf("/");
  return slash === -1 ? "" : folder.slice(0, slash);
}

const getVersion = (entry: unknown) =>
  isRecord(entry) && typeof entry.version === "string" && entry.link !== true ? entry.version : undefined;

/** `package-lock.json` v2 and v3: `packages` keyed by install path. */
function readInstallPaths(
  packages: Record<string, unknown>,
  text: string,
  isWatched: (name: string) => boolean,
): NpmLockfile {
  const offsets = findObjectKeys(text);
  const toLine = createLineLocator(text);
  const locate = (key: string, name: string, version: string): LockedVersion => ({
    name,
    version,
    line: toLine(offsets.get(key) ?? 0),
  });
  const watched: LockedVersion[] = [];
  for (const [key, entry] of Object.entries(packages)) {
    const at = key.lastIndexOf(NODE_MODULES);
    if (at === -1) continue;
    const name = key.slice(at + NODE_MODULES.length);
    const version = getVersion(entry);
    if (version !== undefined && isWatched(name)) watched.push(locate(key, name, version));
  }
  return {
    hasImporter: (folder) => folder === "" || isRecord(packages[folder]),
    // Node resolution: the project's own node_modules first, then every folder above it.
    resolveDirect(folder, name) {
      let current = folder;
      for (;;) {
        const key = `${current === "" ? "" : `${current}/`}${NODE_MODULES}${name}`;
        const entry = packages[key];
        if (entry !== undefined) {
          const version = getVersion(entry);
          return version === undefined ? undefined : locate(key, name, version);
        }
        if (current === "") return undefined;
        current = getParentFolder(current);
      }
    },
    watched,
  };
}

/** `package-lock.json` v1: `dependencies` keyed by name, nested for copies that are not hoisted. */
function readDependencyTree(
  dependencies: Record<string, unknown>,
  text: string,
  isWatched: (name: string) => boolean,
): NpmLockfile {
  const offsets = findObjectKeys(text);
  const toLine = createLineLocator(text);
  const locate = (name: string, version: string): LockedVersion => ({
    name,
    version,
    line: toLine(offsets.get(name) ?? 0),
  });
  const watched: LockedVersion[] = [];
  const visit = (level: Record<string, unknown>) => {
    for (const [name, entry] of Object.entries(level)) {
      const version = getVersion(entry);
      if (version !== undefined && isWatched(name)) watched.push(locate(name, version));
      if (isRecord(entry) && isRecord(entry.dependencies)) visit(entry.dependencies);
    }
  };
  visit(dependencies);
  return {
    hasImporter: (folder) => folder === "",
    resolveDirect(folder, name) {
      if (folder !== "") return undefined;
      const version = getVersion(dependencies[name]);
      return version === undefined ? undefined : locate(name, version);
    },
    watched,
  };
}

/** Reads a `package-lock.json` (lockfile versions 1 to 3). */
export function readPackageLock(
  text: string,
  path: string,
  isWatched: (name: string) => boolean,
): Result<NpmLockfile> {
  const parsed = parseJson(text, path);
  if (!parsed.ok) return parsed;
  const lockfile = parsed.value;
  if (!isRecord(lockfile)) return err(`${path} is not a JSON object`);
  const version = lockfile.lockfileVersion;
  if (version === 2 || version === 3) {
    if (!isRecord(lockfile.packages)) return err(`${path}: "packages" is not an object`);
    return ok(readInstallPaths(lockfile.packages, text, isWatched));
  }
  if (version === 1) {
    return ok(
      readDependencyTree(isRecord(lockfile.dependencies) ? lockfile.dependencies : {}, text, isWatched),
    );
  }
  return err(`${path}: lockfileVersion ${JSON.stringify(version)} is not supported (supported: 1, 2, 3)`);
}
