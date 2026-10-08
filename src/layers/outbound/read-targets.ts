import { err, ok, type Result } from "../../result.js";
import { createLineLocator } from "../error-codes/read-codes.js";

/** One outbound target a pattern captured, with the 1-based line of the capture. */
export type TargetOccurrence = { target: string; line: number };

const SCHEME = /^[A-Za-z][A-Za-z0-9+.-]*:\/\//;

/**
 * The comparable form of a target: no scheme, query or fragment, a lower-case host, single slashes, no trailing slash
 * and no `.` or `..` segments (resolved as RFC 3986 does). `maps.googleapis.com/maps/api/geocode/json` for
 * `https://Maps.googleapis.com/maps/api/place/../geocode/json?key=`. A `..` that climbs above the host is an error.
 */
export function normalizeTarget(target: string): Result<string> {
  const bare = target
    .trim()
    .replace(SCHEME, "")
    .replace(/[?#].*$/s, "");
  const segments = bare.split("/").filter((segment) => segment !== "");
  const [host, ...path] = segments;
  if (host === undefined) return ok("");
  if (host === "." || host === "..") return err(`target "${target.trim()}" has no host`);
  const resolved: string[] = [];
  for (const segment of path) {
    if (segment === ".") continue;
    if (segment !== "..") {
      resolved.push(segment);
      continue;
    }
    if (resolved.length === 0)
      return err(`target "${target.trim()}" climbs above its host ${host.toLowerCase()}`);
    resolved.pop();
  }
  return ok([host.toLowerCase(), ...resolved].join("/"));
}

/**
 * Joins a captured or configured host and a captured path; a path that is an absolute URL stands alone. The host is a
 * base with a trailing slash, so `../geocode/json` against `maps.googleapis.com/maps/api/place` reads as
 * `maps.googleapis.com/maps/api/geocode/json`.
 */
function buildTarget(host: string | undefined, path: string | undefined): Result<string> {
  if (path !== undefined && SCHEME.test(path.trim())) return normalizeTarget(path);
  return normalizeTarget([host, path].filter((part) => part !== undefined && part.trim() !== "").join("/"));
}

/**
 * Every target the named groups `host` and `path` capture in `text`, in text order. A match without a
 * `host` capture takes `defaultHost`; a match that captures nothing is skipped. A target whose `..` segments climb
 * above its host fails the whole read, since the URL the code calls is then unknown. `regex` must carry `g` and `d`.
 */
export function readTargets(text: string, regex: RegExp, defaultHost?: string): Result<TargetOccurrence[]> {
  const getLine = createLineLocator(text);
  const occurrences: TargetOccurrence[] = [];
  // A fresh copy, so a `lastIndex` left by an earlier caller never skips text.
  for (const match of text.matchAll(new RegExp(regex.source, regex.flags))) {
    const host = match.groups?.host?.trim() || undefined;
    const path = match.groups?.path?.trim() || undefined;
    if (host === undefined && path === undefined) continue;
    const indices = match.indices?.groups;
    const line = getLine(indices?.path?.[0] ?? indices?.host?.[0] ?? match.index);
    const target = buildTarget(host ?? defaultHost, path);
    if (!target.ok) return err(`line ${line}: ${target.error}`);
    if (target.value === "") continue;
    occurrences.push({ target: target.value, line });
  }
  return ok(occurrences);
}
