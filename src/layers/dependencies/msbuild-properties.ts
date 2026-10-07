import { posix } from "node:path";
import { err, ok, type Result } from "../../result.js";

/** Reads a file of the same commit; `null` when it does not exist. */
export type ReadMsbuildFile = (path: string) => Promise<Result<string | null>>;

/** The properties MSBuild would see for one file, and the imports that could not be followed. */
export type EvaluatedProperties = { properties: Map<string, string>; skippedImports: string[] };

export type EvaluateOptions = { path: string; readFile: ReadMsbuildFile };

const DIRECTORY_BUILD_PROPS = "Directory.Build.props";
const DIRECTORY_PACKAGES_PROPS = "Directory.Packages.props";
const DIRECTORY_BUILD_TARGETS = "Directory.Build.targets";

/** A property group or an import, in document order. */
const ELEMENT =
  /<PropertyGroup\b[^>]*>([\s\S]*?)<\/PropertyGroup\s*>|<Import\b((?:[^>"']|"[^"]*"|'[^']*')*?)\/?>/g;
const PROPERTY = /<([\w.-]+)\b[^>]*>([^<]*)<\/\1\s*>/g;
const ATTRIBUTE = /([\w.:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
const PATH_OF_FILE_ABOVE = /^\$\(\[MSBuild\]::GetPathOfFileAbove\(\s*'([^']+)'\s*(?:,\s*'([^']*)'\s*)?\)\)$/i;
const THIS_FILE_DIRECTORY = /\$\(MSBuildThisFileDirectory\)\/?/gi;
const PROJECT_DIRECTORY = /\$\(MSBuildProjectDirectory\)/gi;
const XML_ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };

/** Replaces XML comments with spaces, so offsets and line numbers stay where they were. */
export function blankComments(text: string): string {
  return text.replace(/<!--[\s\S]*?-->/g, (comment) => comment.replace(/[^\n]/g, " "));
}

export function decodeEntities(text: string): string {
  return text.replace(/&(amp|lt|gt|quot|apos);/g, (_, name: string) => XML_ENTITIES[name] as string);
}

export function readAttributes(text: string): Map<string, string> {
  const attributes = new Map<string, string>();
  for (const match of text.matchAll(ATTRIBUTE)) {
    attributes.set((match[1] as string).toLowerCase(), decodeEntities(match[2] ?? match[3] ?? "").trim());
  }
  return attributes;
}

/** Applies the properties of one property group; a later definition wins, as in MSBuild. */
function applyPropertyGroup(body: string, properties: Map<string, string>): void {
  for (const property of body.matchAll(PROPERTY)) {
    properties.set((property[1] as string).toLowerCase(), decodeEntities(property[2] as string).trim());
  }
}

/** Properties defined in the text itself, without imports. */
export function readOwnProperties(text: string): Map<string, string> {
  const properties = new Map<string, string>();
  for (const match of blankComments(text).matchAll(ELEMENT)) {
    if (match[1] !== undefined) applyPropertyGroup(match[1], properties);
  }
  return properties;
}

/** A repository-relative path, or `null` when the path leaves the repository. */
function toRepositoryPath(folder: string, relative: string): string | null {
  const joined = posix.normalize(posix.join(folder, relative));
  return joined === ".." || joined.startsWith("../") ? null : joined;
}

const getFolder = (path: string) => posix.dirname(path);

const getParent = (folder: string): string | null => (folder === "." ? null : posix.dirname(folder));

/** The nearest file of that name in the folder or above it, up to the repository root. */
async function findAbove(
  name: string,
  start: string,
  readFile: ReadMsbuildFile,
): Promise<Result<string | null>> {
  for (let folder: string | null = start; folder !== null; folder = getParent(folder)) {
    const candidate = folder === "." ? name : `${folder}/${name}`;
    const text = await readFile(candidate);
    if (!text.ok) return text;
    if (text.value !== null) return ok(candidate);
  }
  return ok(null);
}

type ImportTarget =
  | { kind: "file"; path: string }
  | { kind: "missing" }
  | { kind: "skipped"; reason: string };

type Evaluation = {
  readFile: ReadMsbuildFile;
  projectFolder: string;
  properties: Map<string, string>;
  skippedImports: string[];
  applied: Set<string>;
};

/** Where an `<Import Project="...">` of `importer` points to. */
async function resolveImport(
  project: string,
  importer: string,
  evaluation: Evaluation,
): Promise<Result<ImportTarget>> {
  const folder = getFolder(importer);
  const fromImporter = posix.relative(folder, evaluation.projectFolder);
  const written = project
    .replace(/\\/g, "/")
    .replace(PROJECT_DIRECTORY, fromImporter === "" ? "." : fromImporter)
    .replace(THIS_FILE_DIRECTORY, "./");
  const pathOfFileAbove = PATH_OF_FILE_ABOVE.exec(written);
  if (pathOfFileAbove !== null) {
    const start = toRepositoryPath(folder, pathOfFileAbove[2] || ".");
    if (start === null) return ok({ kind: "skipped", reason: "searches outside the repository" });
    const found = await findAbove(pathOfFileAbove[1] as string, start, evaluation.readFile);
    if (!found.ok) return found;
    return ok(found.value === null ? { kind: "missing" } : { kind: "file", path: found.value });
  }
  if (written.includes("$(")) return ok({ kind: "skipped", reason: "a property in the path" });
  if (/[*?]/.test(written)) return ok({ kind: "skipped", reason: "a wildcard in the path" });
  if (written.startsWith("/") || /^[A-Za-z]:/.test(written)) {
    return ok({ kind: "skipped", reason: "outside the repository" });
  }
  const path = toRepositoryPath(folder, written);
  if (path === null) return ok({ kind: "skipped", reason: "outside the repository" });
  const text = await evaluation.readFile(path);
  if (!text.ok) return text;
  return ok(text.value === null ? { kind: "missing" } : { kind: "file", path });
}

/** Applies the property groups and imports of one file in document order; each file once. */
async function applyFile(path: string, evaluation: Evaluation): Promise<Result<void>> {
  if (evaluation.applied.has(path)) return ok(undefined);
  evaluation.applied.add(path);
  const text = await evaluation.readFile(path);
  if (!text.ok) return text;
  if (text.value === null) return ok(undefined);
  for (const match of blankComments(text.value).matchAll(ELEMENT)) {
    if (match[1] !== undefined) {
      applyPropertyGroup(match[1], evaluation.properties);
      continue;
    }
    const attributes = readAttributes(match[2] as string);
    const project = attributes.get("project");
    // An SDK import is part of the .NET SDK, not of the repository.
    if (project === undefined || project === "" || attributes.has("sdk")) continue;
    const target = await resolveImport(project, path, evaluation);
    if (!target.ok) return err(`cannot resolve import ${project} in ${path}: ${target.error}`);
    if (target.value.kind === "skipped") {
      evaluation.skippedImports.push(`${path}: ${project} (${target.value.reason})`);
    } else if (target.value.kind === "missing") {
      // `Condition="Exists(...)"` is the usual guard of an optional import; without one MSBuild fails.
      if (!attributes.has("condition"))
        evaluation.skippedImports.push(`${path}: ${project} (file not found)`);
    } else {
      const applied = await applyFile(target.value.path, evaluation);
      if (!applied.ok) return applied;
    }
  }
  return ok(undefined);
}

/**
 * Evaluates the properties MSBuild would see for the items of one file: the nearest
 * `Directory.Build.props`, the nearest `Directory.Packages.props`, the file with its imports in
 * document order, then the nearest `Directory.Build.targets`. The last definition wins.
 * `Condition` is not evaluated: every definition and every existing import applies.
 */
export async function evaluateMsbuildProperties(
  options: EvaluateOptions,
): Promise<Result<EvaluatedProperties>> {
  const projectFolder = getFolder(options.path);
  const evaluation: Evaluation = {
    readFile: options.readFile,
    projectFolder,
    properties: new Map(),
    skippedImports: [],
    applied: new Set(),
  };
  const fileName = posix.basename(options.path);
  const autoImport = async (name: string): Promise<Result<void>> => {
    // A file never auto-imports a file of its own name: MSBuild loads only the nearest one.
    if (name === fileName) return ok(undefined);
    const found = await findAbove(name, projectFolder, options.readFile);
    if (!found.ok) return err(`cannot look for ${name} above ${options.path}: ${found.error}`);
    return found.value === null ? ok(undefined) : applyFile(found.value, evaluation);
  };
  for (const step of [
    () => autoImport(DIRECTORY_BUILD_PROPS),
    () => autoImport(DIRECTORY_PACKAGES_PROPS),
    () => applyFile(options.path, evaluation),
    () => autoImport(DIRECTORY_BUILD_TARGETS),
  ]) {
    const done = await step();
    if (!done.ok) return done;
  }
  return ok({ properties: evaluation.properties, skippedImports: evaluation.skippedImports });
}
