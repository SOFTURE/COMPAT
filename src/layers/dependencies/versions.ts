/** A declared version reduced to what ordering needs; `parts` holds major, minor, patch and revision. */
export type Version = { parts: [number, number, number, number]; prerelease: string; text: string };

export type Bump = "major" | "minor" | "patch" | "other";

const VERSION = /(?<![\w.])v?(\d+)(?:\.(\d+|[xX*]))?(?:\.(\d+|[xX*]))?(?:\.(\d+))?(?:-([0-9A-Za-z.-]+))?/;

/** Markers of a version that is not a number: a URL, a path, a git ref, a workspace link or a tag. */
const NOT_A_VERSION = /^(?:[a-z+]+:|\.{0,2}\/|~\/|[\w.-]+\/[\w.-]+(?:#.*)?$)/i;

function toNumber(part: string | undefined): number {
  return part === undefined || !/^\d+$/.test(part) ? 0 : Number(part);
}

/**
 * Reads the version a declaration resolves to at least: the lower bound of a range (`^1.2.3`,
 * `>=1.2 <2`, `[1.2,2.0)`), a wildcard as zero (`1.x`). `null` when the text is not a version.
 */
export function parseVersion(declared: string): Version | null {
  let text = declared.trim();
  // An npm alias (`npm:other@^1.2.0`) declares the version after the last `@`.
  if (/^npm:/i.test(text)) text = text.slice(text.lastIndexOf("@") + 1);
  if (NOT_A_VERSION.test(text)) return null;
  const match = VERSION.exec(text);
  if (match === null) return null;
  return {
    parts: [toNumber(match[1]), toNumber(match[2]), toNumber(match[3]), toNumber(match[4])],
    prerelease: match[5] ?? "",
    text: declared.trim(),
  };
}

/** Negative when `a` is older than `b`. A prerelease is older than its release. */
export function compareVersions(a: Version, b: Version): number {
  for (let index = 0; index < 4; index++) {
    const difference = (a.parts[index] as number) - (b.parts[index] as number);
    if (difference !== 0) return difference;
  }
  if (a.prerelease === b.prerelease) return 0;
  if (a.prerelease === "") return 1;
  if (b.prerelease === "") return -1;
  return a.prerelease.localeCompare(b.prerelease, "en", { numeric: true });
}

/** The most significant part that differs between two versions. */
export function getBump(from: Version, to: Version): Bump {
  if (from.parts[0] !== to.parts[0]) return "major";
  if (from.parts[1] !== to.parts[1]) return "minor";
  if (from.parts[2] !== to.parts[2]) return "patch";
  return "other";
}

/**
 * Whether an upgrade may break callers under semver: a major bump, a minor bump below 1.0, or any
 * change below 0.1.
 */
export function isBreakingUpgrade(from: Version, to: Version): boolean {
  const bump = getBump(from, to);
  if (bump === "major") return true;
  if (from.parts[0] === 0 && bump === "minor") return true;
  return from.parts[0] === 0 && from.parts[1] === 0 && bump !== "other";
}
