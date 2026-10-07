import { type Declaration, getLineAt } from "./declaration.js";

const ITEM =
  /<(PackageVersion|PackageReference|GlobalPackageReference)\b([^>]*?)(?:\/>|>([\s\S]*?)<\/\1\s*>)/g;
const ATTRIBUTE = /([\w.:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
const PROPERTY_GROUP = /<PropertyGroup\b[^>]*>([\s\S]*?)<\/PropertyGroup\s*>/g;
const PROPERTY = /<([\w.-]+)\b[^>]*>([^<]*)<\/\1\s*>/g;
const PROPERTY_REFERENCE = /\$\(([\w.-]+)\)/g;
const XML_ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };

/** Replaces XML comments with spaces, so offsets and line numbers stay where they were. */
function blankComments(text: string): string {
  return text.replace(/<!--[\s\S]*?-->/g, (comment) => comment.replace(/[^\n]/g, " "));
}

function decodeEntities(text: string): string {
  return text.replace(/&(amp|lt|gt|quot|apos);/g, (_, name: string) => XML_ENTITIES[name] as string);
}

function readAttributes(text: string): Map<string, string> {
  const attributes = new Map<string, string>();
  for (const match of text.matchAll(ATTRIBUTE)) {
    attributes.set((match[1] as string).toLowerCase(), decodeEntities(match[2] ?? match[3] ?? "").trim());
  }
  return attributes;
}

function readChild(body: string | undefined, name: string): string | undefined {
  if (body === undefined) return undefined;
  const match = new RegExp(`<${name}\\b[^>]*>([^<]*)</${name}\\s*>`, "i").exec(body);
  return match === null ? undefined : decodeEntities(match[1] as string).trim();
}

/** Properties defined in the file; a later definition wins, as in MSBuild evaluation order. */
function readProperties(text: string): Map<string, string> {
  const properties = new Map<string, string>();
  for (const group of text.matchAll(PROPERTY_GROUP)) {
    for (const property of (group[1] as string).matchAll(PROPERTY)) {
      properties.set((property[1] as string).toLowerCase(), decodeEntities(property[2] as string).trim());
    }
  }
  return properties;
}

/** Expands `$(Name)` from the file's own properties; unknown properties stay as written. */
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

/**
 * Reads the package versions an MSBuild file declares: central `PackageVersion` entries,
 * `PackageReference` and `GlobalPackageReference` with a version. A reference without a version
 * takes it from the central file, which is read on its own.
 */
export function readNuget(text: string, path: string): Declaration[] {
  const source = blankComments(text);
  const properties = readProperties(source);
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
    declarations.push({
      ecosystem: "nuget",
      name,
      version: expandProperties(version, properties),
      path,
      line: getLineAt(source, match.index),
    });
  }
  return declarations;
}
