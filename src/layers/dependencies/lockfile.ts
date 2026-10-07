/** A package version a lockfile records, at the line of its entry. */
export type LockedVersion = { name: string; version: string; line: number };

/** What the layer reads from an npm or pnpm lockfile. */
export type NpmLockfile = {
  /** Whether the lockfile installs the project in `folder`, relative to the lockfile folder (`""` for that folder). */
  hasImporter(folder: string): boolean;
  /** The installed version of a direct dependency of the project in `folder`; undefined when missing or linked. */
  resolveDirect(folder: string, name: string): LockedVersion | undefined;
  /** Every installed copy of a package whose name is watched. */
  watched: LockedVersion[];
};

export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export function parseJson(
  text: string,
  path: string,
): { ok: true; value: unknown } | { ok: false; error: string } {
  try {
    return { ok: true, value: JSON.parse(text.replace(/^﻿/, "")) };
  } catch (error) {
    return { ok: false, error: `${path} is not valid JSON: ${(error as Error).message}` };
  }
}

/** Offsets of the object keys a JSON lockfile writes as `"key": {`, collected in one pass; the first one wins. */
export function findObjectKeys(text: string): Map<string, number> {
  const offsets = new Map<string, number>();
  for (const match of text.matchAll(/"((?:[^"\\\n]|\\.)*)"\s*:\s*\{/g)) {
    let key: string;
    try {
      key = JSON.parse(`"${match[1] as string}"`) as string;
    } catch {
      // A match inside a string value with odd escapes; such a key is never looked up.
      continue;
    }
    if (!offsets.has(key)) offsets.set(key, match.index);
  }
  return offsets;
}
