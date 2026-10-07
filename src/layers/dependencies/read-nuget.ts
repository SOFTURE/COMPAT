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

/** Expands `$(Name)` from the evaluated properties once; unknown and ambiguous names stay as written. */
function expandProperties(value: string, evaluated: EvaluatedProperties): string {
  return value.replace(PROPERTY_REFERENCE, (reference, name: string) => {
    const key = name.toLowerCase();
    return evaluated.ambiguous.has(key) ? reference : (evaluated.properties.get(key) ?? reference);
  });
}

/** Why a version still holds `$(...)` after expansion. */
function describeUnresolved(version: string, path: string, evaluated: EvaluatedProperties): string {
  const names = [...new Set([...version.matchAll(PROPERTY_REFERENCE)].map((match) => match[1] as string))];
  if (names.length === 0) return "a property function is not evaluated";
  const reasons: string[] = [];
  const undefinedNames = names.filter((name) => !evaluated.ambiguous.has(name.toLowerCase()));
  for (const name of names) {
    const values = evaluated.ambiguous.get(name.toLowerCase());
    if (values !== undefined)
      reasons.push(`$(${name}) has different values under conditions (${values.join(" | ")})`);
  }
  if (undefinedNames.length > 0) {
    const skipped =
      evaluated.skippedImports.length === 0
        ? ""
        : `; imports not followed: ${evaluated.skippedImports.join("; ")}`;
    reasons.push(
      `${undefinedNames.map((name) => `$(${name})`).join(", ")} is not defined in ${path}, its Directory.Build.props, ` +
        `Directory.Packages.props, Directory.Build.targets or in-repository imports${skipped}`,
    );
  }
  return reasons.join("; ");
}

/**
 * Reads the package versions an MSBuild file declares: central `PackageVersion` entries,
 * `PackageReference` and `GlobalPackageReference` with a version. A reference without a version
 * takes it from the central file, which is read on its own. `$(Name)` expands from `evaluated`
 * (see `evaluateMsbuildProperties`), or from the file's own properties without it.
 */
export function readNuget(text: string, path: string, evaluated?: EvaluatedProperties): Declaration[] {
  const source = blankComments(text);
  const properties = evaluated ?? readOwnProperties(source);
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
    if (expanded.includes("$(")) declaration.unresolved = describeUnresolved(expanded, path, properties);
    declarations.push(declaration);
  }
  return declarations;
}
