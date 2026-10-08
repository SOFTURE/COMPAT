import { createLineLocator } from "../error-codes/read-codes.js";

/** One outbound target a pattern captured, with the 1-based line of the capture. */
export type TargetOccurrence = { target: string; line: number };

const SCHEME = /^[A-Za-z][A-Za-z0-9+.-]*:\/\//;

/**
 * The comparable form of a target: no scheme, query or fragment, a lower-case host, single slashes and no
 * trailing slash. `maps.googleapis.com/maps/api/geocode/json` for `https://Maps.googleapis.com/maps/api/geocode/json?key=`.
 */
export function normalizeTarget(target: string): string {
  const bare = target
    .trim()
    .replace(SCHEME, "")
    .replace(/[?#].*$/s, "");
  const joined = bare.replace(/\/{2,}/g, "/").replace(/^\/+|\/+$/g, "");
  const slash = joined.indexOf("/");
  return slash === -1 ? joined.toLowerCase() : joined.slice(0, slash).toLowerCase() + joined.slice(slash);
}

/** Joins a captured or configured host and a captured path; a path that is an absolute URL stands alone. */
function buildTarget(host: string | undefined, path: string | undefined): string {
  if (path !== undefined && SCHEME.test(path.trim())) return normalizeTarget(path);
  return normalizeTarget([host, path].filter((part) => part !== undefined && part.trim() !== "").join("/"));
}

/**
 * Every target the named groups `host` and `path` capture in `text`, in text order. A match without a
 * `host` capture takes `defaultHost`; a match that captures nothing is skipped. `regex` must carry `g` and `d`.
 */
export function readTargets(text: string, regex: RegExp, defaultHost?: string): TargetOccurrence[] {
  const getLine = createLineLocator(text);
  const occurrences: TargetOccurrence[] = [];
  // A fresh copy, so a `lastIndex` left by an earlier caller never skips text.
  for (const match of text.matchAll(new RegExp(regex.source, regex.flags))) {
    const host = match.groups?.host?.trim() || undefined;
    const path = match.groups?.path?.trim() || undefined;
    if (host === undefined && path === undefined) continue;
    const target = buildTarget(host ?? defaultHost, path);
    if (target === "") continue;
    const indices = match.indices?.groups;
    const offset = indices?.path?.[0] ?? indices?.host?.[0] ?? match.index;
    occurrences.push({ target, line: getLine(offset) });
  }
  return occurrences;
}
