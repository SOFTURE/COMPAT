import { type Declaration, getLineAt } from "./declaration.js";
import {
  blankComments,
  decodeEntities,
  type EvaluatedProperties,
  readAttributes,
  readOwnProperties,
} from "./msbuild-properties.js";

const ITEM =
  /<(PackageVersion|PackageReference|GlobalPackageReference)\b([^>]*?)(?:\/>|>([\s\S]*?)<\/\1\s*>)/g;
const PROPERTY_REFERENCE = /\$\(([\w.-]+)\)/g;

function readChild(body: string | undefined, name: string): string | undefined {
  if (body === undefined) return undefined;
  const match = new RegExp(`<${name}\\b[^>]*>([^<]*)</${name}\\s*>`, "i").exec(body);
  return match === null ? undefined : decodeEntities(match[1] as string).trim();
}

/** Expands `$(Name)` from the evaluated properties; unknown properties stay as written. */
function expandProperties(value: string, properties: Map<string, string>): string {
  let expanded = value;
  // A property may refer to another one; a few rounds cover real files without looping on cycles.
  for (let round = 0; round < 5 && expanded.includes("$("); round++) {
    expanded = expanded.replace(
      PROPERTY_REFERENCE,
      (reference, name: string) => properties.get(name.toLowerCase()) ?? reference,
    );
  }
  return expanded;
}

/** Why a version still holds `$(...)` after expansion. */
function describeUnresolved(version: string, path: string, skippedImports: string[]): string {
  const names = [...new Set([...version.matchAll(PROPERTY_REFERENCE)].map((match) => `$(${match[1]})`))];
  const subject = names.length === 0 ? "a property function" : names.join(", ");
  const skipped = skippedImports.length === 0 ? "" : `; imports not followed: ${skippedImports.join("; ")}`;
  return `${subject} is not defined in ${path}, its Directory.Build.props, Directory.Packages.props, Directory.Build.targets or in-repository imports${skipped}`;
}

/**
 * Reads the package versions an MSBuild file declares: central `PackageVersion` entries,
 * `PackageReference` and `GlobalPackageReference` with a version. A reference without a version
 * takes it from the central file, which is read on its own. `$(Name)` expands from `evaluated`
 * (see `evaluateMsbuildProperties`), or from the file's own properties without it.
 */
export function readNuget(text: string, path: string, evaluated?: EvaluatedProperties): Declaration[] {
  const source = blankComments(text);
  const properties = evaluated?.properties ?? readOwnProperties(source);
  const skippedImports = evaluated?.skippedImports ?? [];
  const declarations: Declaration[] = [];
  for (const match of source.matchAll(ITEM)) {
    const attributes = readAttributes(match[2] as string);
    const name = attributes.get("include") ?? attributes.get("update");
    if (name === undefined || name === "" || name.includes("$(")) continue;
    const version =
      attributes.get("versionoverride") ??
      readChild(match[3], "VersionOverride") ??
      attributes.get("version") ??
      readChild(match[3], "Version");
    if (version === undefined || version === "") continue;
    const expanded = expandProperties(version, properties);
    const declaration: Declaration = {
      ecosystem: "nuget",
      name,
      version: expanded,
      path,
      line: getLineAt(source, match.index),
    };
    if (expanded.includes("$(")) declaration.unresolved = describeUnresolved(expanded, path, skippedImports);
    declarations.push(declaration);
  }
  return declarations;
}
