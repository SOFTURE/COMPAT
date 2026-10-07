import type { RefTree } from "../../git/ref-tree.js";
import type { LayerResult } from "../../model/finding.js";
import { err, ok, type Result } from "../../result.js";
import { defineLayer } from "../layer.js";
import {
  addDeclarations,
  applyAccept,
  classifyPackages,
  createNameMatcher,
  DEPENDENCIES_LAYER,
  type PackageIndex,
} from "./classify.js";
import { type DependencySource, dependenciesConfigSchema } from "./config.js";
import type { Declaration } from "./declaration.js";
import { readNpm } from "./read-npm.js";
import { readNuget } from "./read-nuget.js";
import { preferResolved, resolveNpm, resolveNuget } from "./resolve-lockfiles.js";

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
    const { findings, usage } = applyAccept(classified.findings, context.config.accept ?? []);
    for (const { entry, count } of usage) {
      notes.push(
        count === 0
          ? `accept entry ${entry.id} on ${entry.name} matched nothing; remove it if the change is gone`
          : `accept entry ${entry.id} on ${entry.name} accepted ${count} finding(s)`,
      );
    }
    return { layer: DEPENDENCIES_LAYER, status: "ran", findings, notes } satisfies LayerResult;
  },
});

function failed(error: string, notes: string[]): LayerResult {
  return { layer: DEPENDENCIES_LAYER, status: "failed", error, findings: [], notes };
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
  for (const path of files) {
    const text = await tree.readFile(path);
    if (!text.ok) return err(`cannot read ${path} at ${tree.ref}: ${text.error}`);
    if (text.value === null) continue;
    if (source.kind === "nuget") {
      declarations.push(...readNuget(text.value, path));
      continue;
    }
    const read = readNpm(text.value, path, source.sections);
    if (!read.ok) return err(`at ${tree.ref}: ${read.error}`);
    declarations.push(...read.value);
  }
  return ok(declarations);
}
