import { err, ok, type Result } from "../../result.js";
import type { LockedVersion, NpmLockfile } from "./lockfile.js";

const IMPORTER_SECTIONS = new Set(["dependencies", "devDependencies", "optionalDependencies"]);

/** Lockfile majors whose layout this reader knows: 5.x (pnpm 6/7), 6.x (pnpm 8), 9.x (pnpm 9 and 10). */
const SUPPORTED_MAJORS = new Set([5, 6, 9]);

const ROOT_IMPORTER = ".";

/** `key: value` at some indentation; the key may be quoted. */
const ENTRY = /^( *)(?:'((?:[^']|'')*)'|"((?:[^"\\]|\\.)*)"|([^\s'"#-][^:]*?|-[^\s:][^:]*?)):(?:\s+(.*))?$/;

function unquote(value: string): string {
  const text = value.trim();
  if (text.startsWith("'") && text.endsWith("'")) return text.slice(1, -1).replace(/''/g, "'");
  if (text.startsWith('"') && text.endsWith('"')) return JSON.parse(text) as string;
  return text;
}

/** The version without the peer suffix: `1.2.3(react@18.2.0)` (6.x and later) or `1.2.3_react@18.2.0` (5.x). */
function stripPeers(version: string, major: number): string {
  const cut = version.search(major < 6 ? /[(_]/ : /\(/);
  return cut === -1 ? version : version.slice(0, cut);
}

/** Name and version of a `packages` key: `/name/1.2.3` (5.x), `/name@1.2.3` (6.x) or `name@1.2.3` (9.x). */
function splitPackageKey(key: string, major: number): { name: string; version: string } | undefined {
  const text = key.startsWith("/") ? key.slice(1) : key;
  const at = major < 6 ? text.lastIndexOf("/") : text.indexOf("@", 1);
  if (at <= 0) return undefined;
  return { name: text.slice(0, at), version: stripPeers(text.slice(at + 1), major) };
}

type Line = { indent: number; key: string; value: string | undefined; line: number };

function* readEntries(text: string): Generator<Line> {
  const lines = text.split(/\r?\n/);
  for (let index = 0; index < lines.length; index++) {
    const raw = lines[index] as string;
    if (raw.trim() === "" || raw.trimStart().startsWith("#")) continue;
    const match = ENTRY.exec(raw);
    if (match === null) continue;
    const quoted = match[2] !== undefined ? match[2].replace(/''/g, "'") : undefined;
    const key =
      quoted ?? (match[3] !== undefined ? (JSON.parse(`"${match[3]}"`) as string) : (match[4] as string));
    const value = match[5]?.replace(/\s+#.*$/, "");
    yield {
      indent: (match[1] as string).length,
      key,
      value: value === "" ? undefined : value,
      line: index + 1,
    };
  }
}

/**
 * Reads a `pnpm-lock.yaml` line by line: importer dependencies and `packages` keys only, so a large lockfile is
 * never turned into a full YAML tree.
 */
export function readPnpmLock(
  text: string,
  path: string,
  isWatched: (name: string) => boolean,
): Result<NpmLockfile> {
  const direct = new Map<string, LockedVersion>();
  const watched: LockedVersion[] = [];
  const importers = new Set<string>();
  const stack: { indent: number; key: string }[] = [];
  let major: number | undefined;
  for (const entry of readEntries(text)) {
    while (stack.length > 0 && (stack.at(-1) as { indent: number }).indent >= entry.indent) stack.pop();
    const keys = [...stack.map((parent) => parent.key), entry.key];
    stack.push({ indent: entry.indent, key: entry.key });
    if (keys.length === 1 && entry.key === "lockfileVersion") {
      major = Number.parseInt(unquote(entry.value ?? ""), 10);
      if (!SUPPORTED_MAJORS.has(major)) {
        return err(
          `${path}: lockfileVersion ${entry.value ?? "(empty)"} is not supported (supported: 5.x, 6.x, 9.x)`,
        );
      }
      continue;
    }
    if (major === undefined) continue;
    // Importer dependencies: `importers.<dir>.<section>.<name>` or `<section>.<name>` for a single project.
    const importer = keys[0] === "importers" ? keys[1] : ROOT_IMPORTER;
    const rest = keys[0] === "importers" ? keys.slice(2) : keys;
    if (importer !== undefined && keys[0] === "importers" && keys.length === 2) importers.add(importer);
    if (importer !== undefined && rest.length >= 2 && IMPORTER_SECTIONS.has(rest[0] as string)) {
      if (keys[0] !== "importers") importers.add(ROOT_IMPORTER);
      const name = rest[1] as string;
      // 5.x writes `name: version`; 6.x and later write `name:` with `version:` below it.
      const isVersion =
        (rest.length === 2 && entry.value !== undefined) || (rest.length === 3 && rest[2] === "version");
      if (isVersion && entry.value !== undefined) {
        const version = stripPeers(unquote(entry.value), major);
        if (!version.startsWith("link:") && !version.startsWith("file:")) {
          direct.set(`${importer}\n${name}`, { name, version, line: entry.line });
        }
      }
      continue;
    }
    if (keys.length === 2 && keys[0] === "packages") {
      const locked = splitPackageKey(entry.key, major);
      if (locked !== undefined && isWatched(locked.name)) watched.push({ ...locked, line: entry.line });
    }
  }
  if (major === undefined) return err(`${path}: no lockfileVersion; not a pnpm lockfile`);
  const toImporter = (folder: string) => (folder === "" ? ROOT_IMPORTER : folder);
  return ok({
    hasImporter: (folder) => importers.has(toImporter(folder)),
    resolveDirect: (folder, name) => direct.get(`${toImporter(folder)}\n${name}`),
    watched,
  });
}
