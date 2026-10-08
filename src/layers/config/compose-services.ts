import { getIndent, isBlank, maskYamlComments } from "./yaml-text.js";

/** A key a compose service sets in its `environment`, with the 1-based line of the entry. */
export type ServiceVariable = { key: string; line: number };

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
    const key = isItem ? getEntryKey(line.slice(indent + 2)) : getMappingKey(line);
    if (key !== null) variables.push({ key, line: index + 1 });
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
    .map((entry) => (isMapping ? getFlowMappingKey(entry) : getEntryKey(entry)))
    .filter((key): key is string => key !== null)
    .map((key) => ({ key, line }));
}

/** The key of a sequence entry `KEY=value`, `KEY` or a quoted form. */
function getEntryKey(entry: string): string | null {
  const key = unquote(entry.trim()).split("=")[0]?.trim() ?? "";
  return /^[A-Za-z_][\w.:-]*$/.test(key) ? key : null;
}

function getMappingKey(line: string): string | null {
  const match = KEY_LINE.exec(line);
  return match === null ? null : (match[2] ?? match[3] ?? match[4] ?? "").trim() || null;
}

function getFlowMappingKey(entry: string): string | null {
  const key = unquote(entry.split(":")[0]?.trim() ?? "");
  return key === "" ? null : key;
}

function unquote(text: string): string {
  const match = /^(["'])(.*)\1$/.exec(text);
  return match === null ? text : (match[2] as string);
}
