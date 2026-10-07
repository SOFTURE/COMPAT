import { err, ok, type Result } from "../result.js";

const VERSION_PATTERN = /(\d+(?:\.\d+)*)/;

/** The numeric segments of the first version in a tag (`v2.1.0-rc1` → [2, 1, 0]), or `undefined`. */
export function parseVersion(text: string): number[] | undefined {
  const match = VERSION_PATTERN.exec(text);
  return match?.[1]?.split(".").map(Number);
}

/** Negative when `a` is lower than `b`; missing segments count as zero. */
export function compareVersions(a: number[], b: number[]): number {
  for (let index = 0; index < Math.max(a.length, b.length); index++) {
    const difference = (a[index] ?? 0) - (b[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

/** Sorts tags by version (tags without one last, by name) and keeps those at or above `since`. */
export function selectTags(tags: string[], since: string | undefined): Result<string[]> {
  const sinceVersion = since === undefined ? undefined : parseVersion(since);
  if (since !== undefined && sinceVersion === undefined) return err(`"since" ${since} holds no version`);
  const versioned = tags.map((tag) => ({ tag, version: parseVersion(tag) }));
  const kept = versioned.filter(
    ({ version }) =>
      sinceVersion === undefined || (version !== undefined && compareVersions(version, sinceVersion) >= 0),
  );
  kept.sort((a, b) => {
    if (a.version === undefined || b.version === undefined) {
      if (a.version !== b.version) return a.version === undefined ? 1 : -1;
      return a.tag.localeCompare(b.tag);
    }
    return compareVersions(a.version, b.version) || a.tag.localeCompare(b.tag);
  });
  return ok(kept.map(({ tag }) => tag));
}
