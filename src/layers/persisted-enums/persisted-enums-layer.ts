import type { RefTree } from "../../git/ref-tree.js";
import type { Evidence, Exposure, Finding, LayerResult, Side } from "../../model/finding.js";
import { describeProcessError, getTailLines, runProcess } from "../../process/run-process.js";
import { err, ok, type Result } from "../../result.js";
import { defineLayer } from "../layer.js";
import { compareEnums, type EnumStorage, type MemberChange } from "./compare-enums.js";
import {
  type AcceptEntry,
  type PersistedEnumFindingId,
  type PersistedEnumsConfig,
  persistedEnumsConfigSchema,
} from "./config.js";
import { type EnumDeclaration, type EnumMember, parseEnums } from "./parse-enums.js";
import { type AddedStringMember, refineSeedFindings } from "./refine-seed.js";

export const EXPOSED_ADDED_ID = "enum-member-exposed-added";

import type { SourceLanguage } from "./tokenize.js";

export const PERSISTED_ENUMS_LAYER = "persisted-enums";

const READ_CONCURRENCY = 16;
const GIT_GREP_TIMEOUT_MS = 600_000;
const LANGUAGE_BY_EXTENSION: Record<string, SourceLanguage> = {
  ".cs": "csharp",
  ".ts": "typescript",
  ".tsx": "typescript",
  ".mts": "typescript",
  ".cts": "typescript",
};

type Sides = { base: RefTree; revision: RefTree };

type DiscoverySite = { storage: EnumStorage; side: Side; path: string; line: number };

/**
 * One enum to check. `discovery` is where the pattern found it; a target without a named entry
 * (`isNamed: false`) that is declared nowhere is a false discovery match, not a failure.
 */
type Target = {
  name: string;
  storage: EnumStorage;
  isNamed: boolean;
  file?: string;
  discovery?: Evidence;
  /** DTO fields that send the enum to clients as a plain string. */
  exposed?: Exposure[];
};

type Located = { path: string; declaration: EnumDeclaration };

/** A file where an enum is declared but the parser could not read it. */
type Unreadable = { path: string; reason: string };

/** Every enum declared in the source files of one ref, by simple name, and those the parser could not read. */
type SourceIndex = { byName: Map<string, Located[]>; unreadable: Map<string, Unreadable[]> };

/** A declaration-looking line (`public enum Status`, `export const enum Status`), comments excluded. */
const DECLARATION_LINE =
  /^[ \t]*(?:(?:public|internal|private|protected|file|new|export|declare|const)[ \t]+)*enum[ \t]+@?([A-Za-z_][A-Za-z0-9_]*)\b/gm;

/**
 * A finding with the member names it is about; the accept allowlist matches on them. `storedValue`
 * is what rows hold for a member added to a string-stored enum; seed rows are matched on it.
 */
type ClassifiedFinding = { finding: Finding; members: string[]; storedValue?: string };

export const persistedEnumsLayer = defineLayer({
  name: PERSISTED_ENUMS_LAYER,
  description: "Enums stored in the database: members compared with storage-aware rules",
  configSchema: persistedEnumsConfigSchema,
  async run(context) {
    const sides: Sides = { base: context.base, revision: context.revision };
    const readers = { base: createReader(context.base), revision: createReader(context.revision) };
    const notes: string[] = [];
    const errors: string[] = [];

    const discovered = await discoverEnums(context.config, sides, readers, notes);
    if (!discovered.ok) return failed(discovered.error, [], notes);
    const targets = buildTargets(context.config, discovered.value, sides, errors, notes);

    const pinnedFiles = targets.flatMap((target) => (target.file ? [target.file] : []));
    const indexes = await Promise.all(
      (["base", "revision"] as const).map((side) =>
        indexSources({
          tree: sides[side],
          read: readers[side],
          repoDir: context.repoDir,
          env: context.env,
          sources: context.config.sources,
          pinnedFiles,
        }),
      ),
    );
    const [baseIndex, revisionIndex] = indexes;
    if (!baseIndex?.ok) return failed(baseIndex?.error ?? "cannot index the base sources", [], notes);
    if (!revisionIndex?.ok)
      return failed(revisionIndex?.error ?? "cannot index the revision sources", [], notes);
    if (revisionIndex.value.ignored > 0) {
      notes.push(
        `${revisionIndex.value.ignored} file(s) matched by sources are neither C# nor TypeScript and were skipped`,
      );
    }

    const classified: ClassifiedFinding[] = [];
    let checkedCount = 0;
    const undeclaredDiscoveries: string[] = [];
    // Every enum is checked even when one fails, so the findings of the others still reach the gate.
    for (const target of targets) {
      const outcome = checkTarget({
        target,
        sides,
        base: baseIndex.value.index,
        revision: revisionIndex.value.index,
      });
      if (!outcome.ok) {
        errors.push(`enum "${target.name}": ${outcome.error}`);
        continue;
      }
      if (outcome.value === null) {
        undeclaredDiscoveries.push(target.name);
        notes.push(
          `enum "${target.name}" was discovered but is declared in no source file at either ref; it is not checked`,
        );
        continue;
      }
      classified.push(...outcome.value);
      checkedCount++;
    }
    notes.unshift(`${checkedCount} persisted enum(s) checked`);
    const discoveredCount = targets.filter((target) => !target.isNamed).length;
    if (discoveredCount > 0 && undeclaredDiscoveries.length === discoveredCount) {
      // One false match (a generic `T`) is normal; nothing declared at all means `sources` misses the enums.
      errors.push(
        `discovery found ${undeclaredDiscoveries.join(", ")} but none is declared in the sources at either ref; check "sources"`,
      );
    }

    const accepted = applyAccept(classified, context.config.accept ?? []);
    notes.push(...accepted.notes);
    const added = classified.flatMap(({ finding, members, storedValue }, index): AddedStringMember[] =>
      storedValue === undefined
        ? []
        : [{ index, enumName: finding.scope, member: members[0] as string, storedValue }],
    );
    const { findings, revisions } = refineSeedFindings(accepted.findings, added, context.results ?? []);
    if (errors.length > 0) return { ...failed(errors.join("; "), findings, notes), revisions };
    return { layer: PERSISTED_ENUMS_LAYER, status: "ran", findings, notes, revisions };
  },
});

function failed(error: string, findings: Finding[], notes: string[]): LayerResult {
  return { layer: PERSISTED_ENUMS_LAYER, status: "failed", error, findings, notes };
}

type Reader = (path: string) => Promise<Result<string | null>>;

/** Reads files of one ref at most once each. */
function createReader(tree: RefTree): Reader {
  const cache = new Map<string, Promise<Result<string | null>>>();
  return (path) => {
    let content = cache.get(path);
    if (content === undefined) {
      content = tree.readFile(path);
      cache.set(path, content);
    }
    return content;
  };
}

async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  map: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await map(items[index] as T);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

function getLineAt(text: string, offset: number): number {
  let line = 1;
  for (let index = 0; index < offset; index++) if (text.charCodeAt(index) === 10) line++;
  return line;
}

/** The simple enum name from a captured type: `Domain.NotificationType?` is `NotificationType`. */
function toEnumName(captured: string): string | null {
  const name = captured.trim().replace(/\?$/, "").split(/\.|::/).at(-1)?.trim() ?? "";
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(name) ? name : null;
}

async function discoverEnums(
  config: PersistedEnumsConfig,
  sides: Sides,
  readers: Record<Side, Reader>,
  notes: string[],
): Promise<Result<Map<string, DiscoverySite[]>>> {
  const sites = new Map<string, DiscoverySite[]>();
  for (const entry of config.enums) {
    if (entry.kind !== "discover") continue;
    for (const side of ["base", "revision"] as const) {
      const files = await sides[side].listFiles(entry.files);
      if (!files.ok) return err(`cannot list ${side} files for discovery: ${files.error}`);
      for (const path of files.value) {
        const text = await readers[side](path);
        if (!text.ok) return err(text.error);
        if (text.value === null) continue;
        for (const match of text.value.matchAll(new RegExp(entry.pattern, "gm"))) {
          const captured = match.groups?.name ?? match[1];
          const name = captured === undefined ? null : toEnumName(captured);
          const line = getLineAt(text.value, match.index);
          if (name === null) {
            notes.push(`discovery match at ${path}:${line} (${side}) captured no enum name; skipped`);
            continue;
          }
          const site = { storage: entry.storage, side, path, line };
          sites.set(name, [...(sites.get(name) ?? []), site]);
        }
      }
    }
  }
  return ok(sites);
}

function buildTargets(
  config: PersistedEnumsConfig,
  discovered: Map<string, DiscoverySite[]>,
  sides: Sides,
  errors: string[],
  notes: string[],
): Target[] {
  const named = new Map(
    config.enums.flatMap((entry) => (entry.kind === "named" ? [[entry.name, entry] as const] : [])),
  );
  const targets = new Map<string, Target>();
  for (const [name, sites] of discovered) {
    const site = sites.find((candidate) => candidate.side === "revision") ?? (sites[0] as DiscoverySite);
    const tree = sides[site.side];
    const discovery: Evidence = {
      side: site.side,
      ref: tree.ref,
      commit: tree.commit,
      path: site.path,
      line: site.line,
    };
    if (new Set(sites.map((candidate) => candidate.side)).size === 1) {
      notes.push(`enum "${name}" is discovered only at the ${site.side} ref (${site.path}:${site.line})`);
    }
    const entry = named.get(name);
    if (entry !== undefined) {
      // A named entry wins over discovery; the discovery site still serves as evidence.
      targets.set(name, {
        name,
        storage: entry.storage,
        isNamed: true,
        ...(entry.file ? { file: entry.file } : {}),
        ...(entry.exposed ? { exposed: entry.exposed } : {}),
        discovery,
      });
      continue;
    }
    const storages = [...new Set(sites.map((candidate) => candidate.storage))];
    if (storages.length > 1) {
      errors.push(
        `enum "${name}": discovered with conflicting storage (${storages.join(", ")}); add a named entry`,
      );
      continue;
    }
    targets.set(name, { name, storage: storages[0] as EnumStorage, isNamed: false, discovery });
  }
  for (const [name, entry] of named) {
    if (targets.has(name)) continue;
    targets.set(name, {
      name,
      storage: entry.storage,
      isNamed: true,
      ...(entry.file ? { file: entry.file } : {}),
      ...(entry.exposed ? { exposed: entry.exposed } : {}),
    });
  }
  return [...targets.values()].sort((a, b) => a.name.localeCompare(b.name));
}

type IndexOptions = {
  tree: RefTree;
  read: Reader;
  repoDir: string;
  env: NodeJS.ProcessEnv;
  sources: string | string[];
  pinnedFiles: string[];
};

async function indexSources(options: IndexOptions): Promise<Result<{ index: SourceIndex; ignored: number }>> {
  const listed = await options.tree.listFiles(options.sources);
  if (!listed.ok) return err(`cannot list ${options.tree.side} sources: ${listed.error}`);
  const candidates = await listFilesWithEnums(options);
  if (!candidates.ok) return candidates;
  const paths = [...new Set([...listed.value, ...options.pinnedFiles])];
  const parseable = paths.filter((path) => getLanguage(path) !== undefined);
  const toRead = parseable.filter((path) => candidates.value.has(path) || options.pinnedFiles.includes(path));
  const contents = await mapWithConcurrency(toRead, READ_CONCURRENCY, options.read);
  const index: SourceIndex = { byName: new Map(), unreadable: new Map() };
  const addUnreadable = (name: string, entry: Unreadable) =>
    index.unreadable.set(name, [...(index.unreadable.get(name) ?? []), entry]);
  for (const [position, path] of toRead.entries()) {
    const content = contents[position] as Result<string | null>;
    if (!content.ok) return err(content.error);
    if (content.value === null) continue;
    const parsed = parseEnums(content.value, getLanguage(path) as SourceLanguage);
    for (const declaration of parsed.declarations) {
      index.byName.set(declaration.name, [
        ...(index.byName.get(declaration.name) ?? []),
        { path, declaration },
      ]);
    }
    for (const failure of parsed.failures) addUnreadable(failure.name, { path, reason: failure.error });
    // A declaration the scanner lost (an unusual literal before it) must fail, never read as absent.
    const seen = new Set([
      ...parsed.declarations.map((declaration) => declaration.name),
      ...parsed.failures.map((failure) => failure.name),
    ]);
    for (const match of content.value.matchAll(DECLARATION_LINE)) {
      const name = match[1] as string;
      if (seen.has(name)) continue;
      seen.add(name);
      addUnreadable(name, {
        path,
        reason: `"enum ${name}" at line ${getLineAt(content.value, match.index)} was not recognised by the parser`,
      });
    }
  }
  return ok({ index, ignored: paths.length - parseable.length });
}

/**
 * Files of the commit that contain the word `enum`, from one `git grep` instead of reading every
 * source file, which costs a process per file on a large solution.
 */
async function listFilesWithEnums(options: IndexOptions): Promise<Result<Set<string>>> {
  const { commit } = options.tree;
  const result = await runProcess({
    command: "git",
    args: ["grep", "-l", "-z", "-I", "-w", "-e", "enum", commit, "--"],
    cwd: options.repoDir,
    env: options.env,
    timeoutMs: GIT_GREP_TIMEOUT_MS,
  });
  if (!result.ok) return err(`git grep at ${options.tree.ref}: ${describeProcessError("git", result.error)}`);
  // Exit 1 means no file matched.
  if (result.value.exitCode === 1) return ok(new Set());
  if (result.value.exitCode !== 0) {
    return err(
      `git grep at ${options.tree.ref} exited ${result.value.exitCode}: ${getTailLines(result.value.stderr, 5)}`,
    );
  }
  const prefix = `${commit}:`;
  return ok(
    new Set(
      result.value.stdout
        .split("\0")
        .filter((entry) => entry !== "")
        .map((entry) => (entry.startsWith(prefix) ? entry.slice(prefix.length) : entry)),
    ),
  );
}

function getLanguage(path: string): SourceLanguage | undefined {
  const dot = path.lastIndexOf(".");
  return dot === -1 ? undefined : LANGUAGE_BY_EXTENSION[path.slice(dot).toLowerCase()];
}

/** The declaration of the target at one ref: `null` when absent, an error when ambiguous or unreadable. */
function locate(target: Target, index: SourceIndex, tree: RefTree): Result<Located | null> {
  const isInScope = (path: string) => target.file === undefined || path === target.file;
  const allCandidates = index.byName.get(target.name) ?? [];
  const allUnreadable = index.unreadable.get(target.name) ?? [];
  let candidates = allCandidates.filter((located) => isInScope(located.path));
  let unreadable = allUnreadable.filter((entry) => isInScope(entry.path));
  if (target.file !== undefined && candidates.length === 0 && unreadable.length === 0) {
    // The pinned file may hold the enum at one ref only, when it moved: fall back to the name.
    candidates = allCandidates;
    unreadable = allUnreadable;
  }
  if (unreadable.length > 0) {
    const reasons = unreadable.map((entry) => `${entry.path}: ${entry.reason}`).join("; ");
    const hint =
      candidates.length > 0
        ? ` (also declared in ${candidates.map((c) => c.path).join(", ")}; set "file" if that is the one)`
        : "";
    return err(`cannot be read at ${tree.ref}: ${reasons}${hint}`);
  }
  if (candidates.length > 1) {
    const paths = [...new Set(candidates.map((located) => located.path))].join(", ");
    return err(`declared more than once at ${tree.ref} (${paths}); set "file" on a named entry`);
  }
  return ok(candidates[0] ?? null);
}

type CheckTargetOptions = { target: Target; sides: Sides; base: SourceIndex; revision: SourceIndex };

/** The findings for one enum, or `null` for a discovered name that is declared nowhere. */
function checkTarget({
  target,
  sides,
  base,
  revision,
}: CheckTargetOptions): Result<ClassifiedFinding[] | null> {
  const atBase = locate(target, base, sides.base);
  if (!atBase.ok) return atBase;
  const atRevision = locate(target, revision, sides.revision);
  if (!atRevision.ok) return atRevision;
  const where = target.file ? ` in ${target.file}` : "";
  if (atBase.value === null && atRevision.value === null) {
    if (!target.isNamed) return ok(null);
    return err(`not declared in the sources${where} at either ref`);
  }
  const withDiscovery = (evidence: Evidence[]) =>
    target.discovery ? [...evidence, target.discovery] : evidence;
  if (atBase.value === null || atRevision.value === null) {
    const isAdded = atBase.value === null;
    const located = (atBase.value ?? atRevision.value) as Located;
    const tree = isAdded ? sides.revision : sides.base;
    const finding: Finding = {
      layer: PERSISTED_ENUMS_LAYER,
      scope: target.name,
      id: isAdded ? "enum-added" : "enum-removed",
      subject: target.name,
      class: isAdded ? "safe" : "needs-action",
      message: isAdded
        ? "the enum is new in the revision; no row of the base build holds it"
        : "the enum is no longer declared in the revision; rows may still hold its values, check the column",
      evidence: withDiscovery([toEvidence(tree, located.path, located.declaration.line)]),
    };
    return ok([{ finding, members: [] }]);
  }
  const changes = compareEnums({
    enumName: target.name,
    storage: target.storage,
    base: atBase.value.declaration,
    revision: atRevision.value.declaration,
  });
  const files = {
    base: { tree: sides.base, path: atBase.value.path },
    revision: { tree: sides.revision, path: atRevision.value.path },
  };
  const enumValues = getEnumValues([atBase.value.declaration, atRevision.value.declaration]);
  return ok(
    changes.flatMap((change) => {
      const finding = toFinding(change, target, files);
      const isAddedString =
        change.id === "enum-member-added" && target.storage === "string" && change.revision !== undefined;
      const classified: ClassifiedFinding = {
        finding: { ...finding, evidence: withDiscovery(finding.evidence) },
        members: change.members,
        ...(isAddedString && change.revision
          ? { storedValue: change.revision.stringValue ?? change.revision.name }
          : {}),
      };
      const exposed = toExposedFinding(change, target, classified.finding);
      return exposed === undefined
        ? [classified]
        : [classified, { finding: { ...exposed, enumValues }, members: change.members }];
    }),
  );
}

/** The distinct names and string values of the members of the given declarations, sorted. */
function getEnumValues(declarations: EnumDeclaration[]): string[] {
  const values = declarations.flatMap((declaration) =>
    declaration.members.flatMap((member) =>
      member.stringValue === null ? [member.name] : [member.name, member.stringValue],
    ),
  );
  return [...new Set(values)].sort();
}

/** The client-side finding for a member added to an enum that DTOs send as a plain string. */
function toExposedFinding(change: MemberChange, target: Target, added: Finding): Finding | undefined {
  if (change.id !== "enum-member-added" || target.exposed === undefined || change.revision === undefined) {
    return undefined;
  }
  const value = change.revision.stringValue ?? change.revision.name;
  const fields = target.exposed
    .map((exposure) => `${exposure.fields.join(", ")} (API "${exposure.api}")`)
    .join("; ");
  return {
    layer: PERSISTED_ENUMS_LAYER,
    scope: target.name,
    id: EXPOSED_ADDED_ID,
    subject: change.subject,
    class: "needs-action",
    message: `old clients receive the unknown value "${value}" in ${fields}; check that they tolerate it`,
    evidence: added.evidence,
    exposure: target.exposed.map((exposure) => ({ api: exposure.api, fields: [...exposure.fields] })),
  };
}

function toEvidence(tree: RefTree, path: string, line: number): Evidence {
  return { side: tree.side, ref: tree.ref, commit: tree.commit, path, line };
}

type SideFile = { tree: RefTree; path: string };

function toFinding(change: MemberChange, target: Target, files: Record<Side, SideFile>): Finding {
  const evidence: Evidence[] = [];
  const add = (member: EnumMember | undefined, file: SideFile) => {
    if (member) evidence.push(toEvidence(file.tree, file.path, member.line));
  };
  add(change.base, files.base);
  add(change.revision, files.revision);
  return {
    layer: PERSISTED_ENUMS_LAYER,
    scope: target.name,
    id: change.id,
    subject: change.subject,
    class: change.class,
    message: `${target.storage} storage: ${change.message}`,
    evidence,
  };
}

type AcceptOutcome = { findings: Finding[]; notes: string[] };

function applyAccept(classified: ClassifiedFinding[], accept: AcceptEntry[]): AcceptOutcome {
  const usage = accept.map(() => 0);
  const findings = classified.map(({ finding, members }) => {
    const position = accept.findIndex(
      (entry) =>
        entry.id === (finding.id as PersistedEnumFindingId) &&
        entry.enum === finding.scope &&
        (entry.member === undefined ? members.length === 0 : members.includes(entry.member)),
    );
    if (position === -1) return finding;
    usage[position] = (usage[position] ?? 0) + 1;
    return { ...finding, accepted: { reason: (accept[position] as AcceptEntry).reason } };
  });
  const notes = accept.map((entry, position) => {
    const target = `${entry.id} on ${entry.enum}${entry.member ? `.${entry.member}` : ""}`;
    const count = usage[position] ?? 0;
    return count === 0
      ? `accept entry ${target} matched nothing; remove it if the change is gone`
      : `accept entry ${target} accepted ${count} finding(s)`;
  });
  return { findings, notes };
}
