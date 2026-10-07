import { getTailLines, runProcess } from "../../process/run-process.js";
import { err, ok, type Result } from "../../result.js";
import type { ClientRefs } from "./config.js";

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

/** The git refs a client config names: the list itself, or the matching local tags. */
export async function resolveClientRefs(
  refs: ClientRefs,
  options: { repoDir: string; env: NodeJS.ProcessEnv },
): Promise<Result<string[]>> {
  if (Array.isArray(refs)) return ok([...new Set(refs)]);
  const listed = await runProcess({
    command: "git",
    args: ["tag", "--list", refs.tags],
    cwd: options.repoDir,
    env: options.env,
    timeoutMs: 60_000,
  });
  if (!listed.ok) return err(`git tag --list ${refs.tags} could not run (${listed.error.kind})`);
  if (listed.value.exitCode !== 0) {
    return err(`git tag --list ${refs.tags} failed: ${getTailLines(listed.value.stderr, 5)}`);
  }
  const tags = listed.value.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "");
  const selected = selectTags(tags, refs.since);
  if (!selected.ok) return selected;
  if (selected.value.length === 0) {
    const since = refs.since === undefined ? "" : ` since ${refs.since}`;
    return err(
      `no local tag matches ${refs.tags}${since}; fetch tags (actions/checkout with fetch-depth: 0)`,
    );
  }
  return ok(selected.value);
}
