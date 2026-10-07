import { err, ok, type Result } from "../../result.js";
import { createLineLocator } from "./declaration.js";
import { findObjectKeys, isRecord, type LockedVersion, parseJson } from "./lockfile.js";

/** What a NuGet `packages.lock.json` resolves for its project, over every target framework and runtime. */
export type NugetLockfile = { direct: LockedVersion[]; watched: LockedVersion[] };

const TRANSITIVE_TYPES = new Set(["Transitive", "CentralTransitive"]);

/** Reads a NuGet `packages.lock.json` (versions 1 and 2): `Direct` entries, and watched transitive ones. */
export function readNugetLock(
  text: string,
  path: string,
  isWatched: (name: string) => boolean,
): Result<NugetLockfile> {
  const parsed = parseJson(text, path);
  if (!parsed.ok) return parsed;
  const lockfile = parsed.value;
  if (!isRecord(lockfile)) return err(`${path} is not a JSON object`);
  if (lockfile.version !== 1 && lockfile.version !== 2) {
    return err(`${path}: version ${JSON.stringify(lockfile.version)} is not supported (supported: 1, 2)`);
  }
  if (!isRecord(lockfile.dependencies)) return err(`${path}: "dependencies" is not an object`);
  const offsets = findObjectKeys(text);
  const toLine = createLineLocator(text);
  const direct: LockedVersion[] = [];
  const watched: LockedVersion[] = [];
  for (const target of Object.values(lockfile.dependencies)) {
    if (!isRecord(target)) continue;
    for (const [name, entry] of Object.entries(target)) {
      if (!isRecord(entry) || typeof entry.resolved !== "string") continue;
      const locked = { name, version: entry.resolved, line: toLine(offsets.get(name) ?? 0) };
      if (entry.type === "Direct") direct.push(locked);
      else if (typeof entry.type === "string" && TRANSITIVE_TYPES.has(entry.type) && isWatched(name)) {
        watched.push(locked);
      }
    }
  }
  return ok({ direct, watched });
}
