import { posix } from "node:path";
import { err, ok, type Result } from "../../result.js";

/** Reads a file of the same commit; `null` when it does not exist. */
export type ReadMsbuildFile = (path: string) => Promise<Result<string | null>>;

/**
 * The properties MSBuild would see for one file, already expanded. `ambiguous` holds the
 * properties that conditions give different values (lowercase name to the values); `skippedImports`
 * the imports that could not be followed.
 */
export type EvaluatedProperties = {
  properties: Map<string, string>;
  ambiguous: Map<string, string[]>;
  skippedImports: string[];
};

export type EvaluateOptions = { path: string; readFile: ReadMsbuildFile };

const DIRECTORY_BUILD_PROPS = "Directory.Build.props";
const DIRECTORY_PACKAGES_PROPS = "Directory.Packages.props";
const DIRECTORY_BUILD_TARGETS = "Directory.Build.targets";

/** A property group or an import, in document order. */
const ELEMENT =
  /<PropertyGroup\b((?:[^>"']|"[^"]*"|'[^']*')*?)(?<!\/)>([\s\S]*?)<\/PropertyGroup\s*>|<Import\b((?:[^>"']|"[^"]*"|'[^']*')*?)\/?>/g;
const PROPERTY = /<([\w.-]+)\b((?:[^>"']|"[^"]*"|'[^']*')*?)>([^<]*)<\/\1\s*>/g;
/** Properties inside a target are set when the target runs, after items are evaluated. */
const TARGET = /<Target\b[\s\S]*?<\/Target\s*>/g;
const PROPERTY_REFERENCE = /\$\(([\w.-]+)\)/g;
/** `'$(Name)' == ''` or `!=`: the one condition form decidable without the build's inputs. */
const EMPTY_CHECK = /^\s*(['"]?)\$\(([\w.-]+)\)\1\s*(==|!=)\s*(?:''|"")\s*$/;
const ATTRIBUTE = /([\w.:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
const PATH_OF_FILE_ABOVE = /^\$\(\[MSBuild\]::GetPathOfFileAbove\(\s*'([^']+)'\s*(?:,\s*'([^']*)'\s*)?\)\)$/i;
const THIS_FILE_DIRECTORY = /\$\(MSBuildThisFileDirectory\)\/?/gi;
const PROJECT_DIRECTORY = /\$\(MSBuildProjectDirectory\)/gi;
const XML_ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };

const blank = (text: string) => text.replace(/[^\n]/g, " ");

/** Replaces XML comments with spaces, so offsets and line numbers stay where they were. */
export function blankComments(text: string): string {
  return text.replace(/<!--[\s\S]*?-->/g, blank);
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

/** Property state while files are applied in evaluation order. */
type PropertyState = { properties: Map<string, string>; ambiguous: Map<string, string[]> };

const createPropertyState = (): PropertyState => ({ properties: new Map(), ambiguous: new Map() });

/** `true` or `false` for an empty check, `undefined` for a condition that cannot be decided here. */
function decideCondition(condition: string | undefined, state: PropertyState): boolean | undefined {
  if (condition === undefined || condition === "") return true;
  const check = EMPTY_CHECK.exec(condition);
  if (check === null) return undefined;
  const name = (check[2] as string).toLowerCase();
  if (state.ambiguous.has(name)) return undefined;
  const isEmpty = (state.properties.get(name) ?? "") === "";
  return check[3] === "==" ? isEmpty : !isEmpty;
}

/**
 * Expands `$(Name)` from the properties defined so far, as MSBuild does when a property is
 * defined; unknown names stay as written. Alternatives of the first ambiguous name are returned too.
 */
function expandNow(value: string, state: PropertyState): { value: string; alternatives?: string[] } {
  const ambiguousName = [...value.matchAll(PROPERTY_REFERENCE)]
    .map((match) => (match[1] as string).toLowerCase())
    .find((name) => state.ambiguous.has(name));
  const expand = (override?: [string, string]) =>
    value.replace(PROPERTY_REFERENCE, (reference, name: string) => {
      const key = name.toLowerCase();
      if (override !== undefined && key === override[0]) return override[1];
      return state.properties.get(key) ?? reference;
    });
  if (ambiguousName === undefined) return { value: expand() };
  const options = state.ambiguous.get(ambiguousName) as string[];
  return { value: expand(), alternatives: options.map((option) => expand([ambiguousName, option])) };
}

function defineProperty(name: string, raw: string, isCertain: boolean, state: PropertyState): void {
  const { value, alternatives } = expandNow(raw, state);
  const previous = state.properties.get(name);
  state.properties.set(name, value);
  if (alternatives !== undefined) {
    state.ambiguous.set(name, [...new Set(alternatives)]);
  } else if (isCertain) {
    state.ambiguous.delete(name);
  } else if (previous !== undefined && previous !== value) {
    // Conditions not evaluated here may pick either value: the version must be compared by hand.
    const known = state.ambiguous.get(name) ?? [previous];
    state.ambiguous.set(name, [...new Set([...known, value])]);
  }
}

/** Applies the properties of one property group; a later definition wins, as in MSBuild. */
function applyPropertyGroup(attributes: string, body: string, state: PropertyState): void {
  const groupApplies = decideCondition(readAttributes(attributes).get("condition"), state);
  if (groupApplies === false) return;
  for (const property of body.matchAll(PROPERTY)) {
    const applies = decideCondition(readAttributes(property[2] as string).get("condition"), state);
    if (applies === false) continue;
    const name = (property[1] as string).toLowerCase();
    const isCertain = groupApplies === true && applies === true;
    defineProperty(name, decodeEntities(property[3] as string).trim(), isCertain, state);
  }
}

/** The text MSBuild evaluates at load time: comments and targets blanked, offsets kept. */
function getEvaluatedText(text: string): string {
  return blankComments(text).replace(TARGET, blank);
}

/** Properties defined in the text itself, without imports. */
export function readOwnProperties(text: string): EvaluatedProperties {
  const state = createPropertyState();
  for (const match of getEvaluatedText(text).matchAll(ELEMENT)) {
    if (match[2] !== undefined) applyPropertyGroup(match[1] as string, match[2], state);
  }
  return { ...state, skippedImports: [] };
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
  state: PropertyState;
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
  for (const match of getEvaluatedText(text.value).matchAll(ELEMENT)) {
    if (match[2] !== undefined) {
      applyPropertyGroup(match[1] as string, match[2], evaluation.state);
      continue;
    }
    const attributes = readAttributes(match[3] as string);
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
 * Only `'$(Name)' == ''` conditions are decided; under any other condition a property that gets
 * different values is ambiguous, and every existing import applies.
 */
export async function evaluateMsbuildProperties(
  options: EvaluateOptions,
): Promise<Result<EvaluatedProperties>> {
  const projectFolder = getFolder(options.path);
  const evaluation: Evaluation = {
    readFile: options.readFile,
    projectFolder,
    state: createPropertyState(),
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
  return ok({ ...evaluation.state, skippedImports: evaluation.skippedImports });
}
