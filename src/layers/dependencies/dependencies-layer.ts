import type { RefTree } from "../../git/ref-tree.js";
import type { LayerResult } from "../../model/finding.js";
import { err, ok, type Result } from "../../result.js";
import { defineLayer } from "../layer.js";
import {
  type AcceptUsage,
  addDeclarations,
  applyAccept,
  classifyPackages,
  createNameMatcher,
  DEPENDENCIES_LAYER,
  type PackageIndex,
} from "./classify.js";
import { type DependencySource, dependenciesConfigSchema } from "./config.js";
import type { Declaration } from "./declaration.js";
import { evaluateMsbuildProperties, type ReadMsbuildFile } from "./msbuild-properties.js";
import { readNpm } from "./read-npm.js";
import { readNuget } from "./read-nuget.js";
import { preferResolved, resolveNpm, resolveNuget } from "./resolve-lockfiles.js";

/** Unresolved versions listed in the notes per ref; the rest are counted. */
const MAX_UNRESOLVED_NOTED = 5;

/** Folders of installed packages and build output: their manifests are not the repository's own. */
const IGNORED_SEGMENTS = new Set(["node_modules", "bin", "obj"]);

type SourceScan = { declarations: Declaration[]; files: string[]; lockfiles: string[] };

export const dependenciesLayer = defineLayer({
  name: DEPENDENCIES_LAYER,
  description: "Runtime dependencies: NuGet and npm package versions declared or locked at both refs",
  configSchema: dependenciesConfigSchema,
  async run(context) {
    const base: PackageIndex = new Map();
    const revision: PackageIndex = new Map();
    const notes: string[] = [];
    let fileCount = 0;
    const watchMatchers = (context.config.watch ?? []).map((entry) => createNameMatcher(entry.name));
    const isWatched = (name: string) => watchMatchers.some((matches) => matches(name));
    for (const source of context.config.sources) {
      const atBase = await scanSource(source, context.base, isWatched);
      if (!atBase.ok) return failed(`${source.kind} source: ${atBase.error}`, notes);
      const atRevision = await scanSource(source, context.revision, isWatched);
      if (!atRevision.ok) return failed(`${source.kind} source: ${atRevision.error}`, notes);
      addDeclarations(base, atBase.value.declarations);
      addDeclarations(revision, atRevision.value.declarations);
      fileCount += atBase.value.files.length + atRevision.value.files.length;
      notes.push(
        `${source.kind}: ${atBase.value.declarations.length} declaration(s) in ${atBase.value.files.length} file(s) at the base, ` +
          `${atRevision.value.declarations.length} in ${atRevision.value.files.length} file(s) in the revision`,
      );
      notes.push(
        ...describeUnresolved(atBase.value.declarations, "the base"),
        ...describeUnresolved(atRevision.value.declarations, "the revision"),
      );
      const lockfiles = [atBase.value.lockfiles.length, atRevision.value.lockfiles.length];
      if (lockfiles[0] !== 0 || lockfiles[1] !== 0) {
        notes.push(
          `${source.kind}: resolved versions from ${lockfiles[0]} lockfile(s) at the base, ${lockfiles[1]} in the revision`,
        );
      }
    }
    // Nothing to compare must not read as "no upgrades".
    if (fileCount === 0) {
      return failed('no dependency file matched the sources at either ref; check "sources"', notes);
    }
    const classified = classifyPackages({
      base,
      revision,
      baseTree: context.base,
      revisionTree: context.revision,
      watch: context.config.watch ?? [],
      ignore: context.config.ignore ?? [],
    });
    if (classified.ignoredCount > 0) {
      notes.push(`${classified.ignoredCount} changed or declared package(s) skipped by "ignore"`);
    }
    const { findings, usage } = applyAccept(
      classified.findings,
      context.config.accept ?? [],
      classified.transitions,
    );
    notes.push(...usage.map(describeAcceptUsage));
    return { layer: DEPENDENCIES_LAYER, status: "ran", findings, notes } satisfies LayerResult;
  },
});

function describeAcceptUsage({ entry, count, stale, acceptedBreaking }: AcceptUsage): string {
  const label = `accept entry ${entry.id} on ${entry.name}`;
  const reviewed = `${entry.from ?? "any"} → ${entry.to ?? "any"}`;
  if (stale.length > 0 && count === 0) {
    return `${label} is for ${reviewed} but the versions are now ${stale.join("; ")}; review the new versions and update the entry`;
  }
  if (count === 0) return `${label} matched nothing; remove it if the change is gone`;
  const pin =
    acceptedBreaking && entry.from === undefined && entry.to === undefined
      ? '; add "from" and "to" so it does not also accept later breaking upgrades'
      : "";
  return `${label} accepted ${count} finding(s)${pin}`;
}

function failed(error: string, notes: string[]): LayerResult {
  return { layer: DEPENDENCIES_LAYER, status: "failed", error, findings: [], notes };
}

/** A note naming the versions that still hold an MSBuild `$(Property)`, so they are never silent. */
function describeUnresolved(declarations: Declaration[], side: string): string[] {
  const unresolved = declarations.filter((declaration) => declaration.unresolved !== undefined);
  if (unresolved.length === 0) return [];
  const listed = unresolved
    .slice(0, MAX_UNRESOLVED_NOTED)
    .map(({ name, version, path, line }) => `${name} ${version} (${path}:${line})`);
  const more =
    unresolved.length > MAX_UNRESOLVED_NOTED ? ` and ${unresolved.length - MAX_UNRESOLVED_NOTED} more` : "";
  return [
    `${unresolved.length} NuGet version(s) keep an undefined MSBuild property at ${side}: ${listed.join(", ")}${more}`,
  ];
}

/** Reads files of one tree once, however many MSBuild files import them. */
function createCachedReader(tree: RefTree): ReadMsbuildFile {
  const cache = new Map<string, ReturnType<ReadMsbuildFile>>();
  return (path) => {
    let text = cache.get(path);
    if (text === undefined) {
      text = tree.readFile(path);
      cache.set(path, text);
    }
    return text;
  };
}

async function scanSource(
  source: DependencySource,
  tree: RefTree,
  isWatched: (name: string) => boolean,
): Promise<Result<SourceScan>> {
  const listed = await tree.listFiles(source.files);
  if (!listed.ok) return err(`cannot list files at ${tree.ref}: ${listed.error}`);
  const files = listed.value.filter(
    (path) => !path.split("/").some((segment) => IGNORED_SEGMENTS.has(segment)),
  );
  const declared = await readManifests(source, tree, files);
  if (!declared.ok) return declared;
  if (!source.lockfiles) return ok({ declarations: declared.value, files, lockfiles: [] });
  const options = { tree, files, declared: declared.value, isWatched };
  const resolved = source.kind === "nuget" ? await resolveNuget(options) : await resolveNpm(options);
  if (!resolved.ok) return resolved;
  return ok({
    declarations: preferResolved(declared.value, resolved.value.declarations),
    files,
    lockfiles: resolved.value.lockfiles,
  });
}

async function readManifests(
  source: DependencySource,
  tree: RefTree,
  files: string[],
): Promise<Result<Declaration[]>> {
  const declarations: Declaration[] = [];
  const readFile = createCachedReader(tree);
  for (const path of files) {
    const text = await readFile(path);
    if (!text.ok) return err(`cannot read ${path} at ${tree.ref}: ${text.error}`);
    if (text.value === null) continue;
    if (source.kind === "nuget") {
      const evaluated = await evaluateMsbuildProperties({ path, readFile });
      if (!evaluated.ok) return err(`at ${tree.ref}: ${evaluated.error}`);
      declarations.push(...readNuget(text.value, path, evaluated.value));
      continue;
    }
    const read = readNpm(text.value, path, source.sections);
    if (!read.ok) return err(`at ${tree.ref}: ${read.error}`);
    declarations.push(...read.value);
  }
  return ok(declarations);
}
