import { getIndent, isBlank, maskYamlComments } from "./yaml-text.js";

/**
 * A key a compose service sets in its `environment`, with the 1-based line of the entry and the value as
 * written (`${SHOP_BASE_URL}`), or `null` for a pass-through entry (`- KEY`, `KEY:`).
 */
export type ServiceVariable = { key: string; line: number; value: string | null };

const KEY_LINE = /^( *)(?:"([^"]*)"|'([^']*)'|([^\s#'"-][^:#]*?))[ \t]*:(?:[ \t]+(.*?))?[ \t\r]*$/;

/**
 * Reads the `environment` of one service under the top-level `services` of a compose file:
 * `- KEY=value`, `- KEY`, `KEY: value` and a one-line flow list or mapping. Returns `null` when the
 * file has no such service. Anchors, merge keys and `env_file` are not followed.
 */
export function readServiceEnvironment(text: string, service: string): ServiceVariable[] | null {
  const masked = maskYamlComments(text);
  const lines = masked.text.split("\n");
  const structural = (index: number): boolean =>
    !masked.scalarLines.has(index) && !isBlank(lines[index] as string);
  const services = findChild(lines, structural, { from: 0, parentIndent: -1, name: "services" });
  if (services === null) return null;
  const node = findChild(lines, structural, { from: services + 1, parentIndent: 0, name: service });
  if (node === null) return null;
  const nodeIndent = getIndent(lines[node] as string);
  const environment = findChild(lines, structural, {
    from: node + 1,
    parentIndent: nodeIndent,
    name: "environment",
  });
  if (environment === null) return [];
  const header = KEY_LINE.exec(lines[environment] as string);
  const inline = (header?.[5] ?? "").trim();
  if (inline !== "") return readFlow(inline, environment + 1);
  return readBlock(lines, structural, {
    from: environment + 1,
    parentIndent: getIndent(lines[environment] as string),
  });
}

type ChildSearch = { from: number; parentIndent: number; name: string };

/** The line of the direct child `name:` of the node indented by `parentIndent`, or `null`. */
function findChild(
  lines: string[],
  structural: (index: number) => boolean,
  { from, parentIndent, name }: ChildSearch,
): number | null {
  let childIndent: number | null = null;
  for (let index = from; index < lines.length; index += 1) {
    if (!structural(index)) continue;
    const line = lines[index] as string;
    const indent = getIndent(line);
    if (indent <= parentIndent) return null;
    childIndent ??= indent;
    if (indent !== childIndent) continue;
    const match = KEY_LINE.exec(line);
    if (match !== null && (match[2] ?? match[3] ?? match[4] ?? "").trim() === name) return index;
  }
  return null;
}

function readBlock(
  lines: string[],
  structural: (index: number) => boolean,
  { from, parentIndent }: { from: number; parentIndent: number },
): ServiceVariable[] {
  const variables: ServiceVariable[] = [];
  let childIndent: number | null = null;
  for (let index = from; index < lines.length; index += 1) {
    if (!structural(index)) continue;
    const line = lines[index] as string;
    const indent = getIndent(line);
    const isItem = /^ *- /.test(line);
    if (indent < parentIndent || (indent === parentIndent && !isItem)) break;
    childIndent ??= indent;
    if (indent !== childIndent) continue;
    const entry = isItem ? readEntry(line.slice(indent + 2)) : readMappingEntry(line);
    if (entry !== null) variables.push({ ...entry, line: index + 1 });
  }
  return variables;
}

/** Reads `[A=1, B]` or `{A: 1, B: 2}` written on one line. */
function readFlow(text: string, line: number): ServiceVariable[] {
  const isMapping = text.startsWith("{");
  if (!isMapping && !text.startsWith("[")) return [];
  return text
    .slice(1, text.lastIndexOf(isMapping ? "}" : "]"))
    .split(",")
    .map((entry) => (isMapping ? readFlowMappingEntry(entry) : readEntry(entry)))
    .filter((entry): entry is EntryText => entry !== null)
    .map((entry) => ({ ...entry, line }));
}

type EntryText = { key: string; value: string | null };

/** A sequence entry `KEY=value`, `KEY` or a quoted form. */
function readEntry(entry: string): EntryText | null {
  const text = unquote(entry.trim());
  const separator = text.indexOf("=");
  const key = (separator === -1 ? text : text.slice(0, separator)).trim();
  if (!/^[A-Za-z_][\w.:-]*$/.test(key)) return null;
  return { key, value: separator === -1 ? null : text.slice(separator + 1).trim() };
}

function readMappingEntry(line: string): EntryText | null {
  const match = KEY_LINE.exec(line);
  const key = match === null ? "" : (match[2] ?? match[3] ?? match[4] ?? "").trim();
  return key === "" ? null : { key, value: readScalar(match?.[5]) };
}

function readFlowMappingEntry(entry: string): EntryText | null {
  const separator = entry.indexOf(":");
  const key = unquote((separator === -1 ? entry : entry.slice(0, separator)).trim());
  if (key === "") return null;
  return { key, value: separator === -1 ? null : readScalar(entry.slice(separator + 1)) };
}

/** A mapping value as written, unquoted; an empty or null value is `null`. */
function readScalar(text: string | undefined): string | null {
  const value = unquote((text ?? "").trim());
  return /^(?:~|null|Null|NULL)?$/.test(value) ? null : value;
}

function unquote(text: string): string {
  const match = /^(["'])(.*)\1$/.exec(text);
  return match === null ? text : (match[2] as string);
}
