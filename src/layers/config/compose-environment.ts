import type { KeyDeclaration } from "./classify.js";
import { getIndent, isBlank, type MaskedYaml } from "./yaml-text.js";

/** A node value: the text after `key:` on line `line`, owned by a key indented by `indent`. */
type NodeStart = { line: number; indent: number; rest: string };

type Context = {
  lines: string[];
  scalarLines: ReadonlySet<number>;
  anchors: Map<string, NodeStart>;
  emit: (key: string, line: number) => void;
};

const KEY_LINE = /^( *)(?:"([^"]*)"|'([^']*)'|([^\s#'"][^:#]*?))[ \t]*:(?:[ \t]+(.*?))?[ \t\r]*$/;
const NULL_VALUE = /^(?:~|null|Null|NULL)?$/;
const MAX_ALIAS_DEPTH = 8;

/**
 * Finds pass-through entries of every `environment` node: sequence items without `=` (`- KEY`,
 * `[KEY]`) and mapping keys with no value (`KEY:`, `KEY: ~`). Compose takes their value from the
 * host, so each is a key without a default. Aliases (`environment: *env`) and merge keys
 * (`<<: *env`) inside an `environment` mapping are resolved.
 */
export function findPassThroughKeys(masked: MaskedYaml): KeyDeclaration[] {
  const lines = masked.text.split("\n");
  const declarations = new Map<string, KeyDeclaration>();
  const context: Context = {
    lines,
    scalarLines: masked.scalarLines,
    anchors: findAnchors(lines, masked.scalarLines),
    emit: (key, line) => declarations.set(`${key}\n${line}`, { key, line: line + 1, default: null }),
  };
  lines.forEach((line, index) => {
    if (masked.scalarLines.has(index)) return;
    const match = KEY_LINE.exec(line);
    if (match === null || getKeyName(match) !== "environment") return;
    readEnvironment(context, { line: index, indent: match[1]?.length ?? 0, rest: match[5] ?? "" }, 0);
  });
  return [...declarations.values()];
}

function getKeyName(match: RegExpExecArray): string {
  return (match[2] ?? match[3] ?? match[4] ?? "").trim();
}

/** Every `key: &name` node, by anchor name. */
function findAnchors(lines: string[], scalarLines: ReadonlySet<number>): Map<string, NodeStart> {
  const anchors = new Map<string, NodeStart>();
  lines.forEach((line, index) => {
    if (scalarLines.has(index)) return;
    const match = KEY_LINE.exec(line);
    const anchor = /^&(\S+)[ \t]*(.*)$/.exec(match?.[5] ?? "");
    if (match === null || anchor === null) return;
    anchors.set(anchor[1] as string, { line: index, indent: match[1]?.length ?? 0, rest: anchor[2] ?? "" });
  });
  return anchors;
}

/** Reads one `environment` node: a flow collection on its own line, an alias, or block children. */
function readEnvironment(context: Context, node: NodeStart, depth: number): void {
  if (depth > MAX_ALIAS_DEPTH) return;
  const rest = node.rest.replace(/^(?:[&!]\S*[ \t]*)+/, "");
  if (rest.startsWith("*")) {
    readAlias(context, rest, depth);
  } else if (rest.startsWith("[") || rest.startsWith("{")) {
    readFlowEntries(context, node.line, rest);
  } else if (rest === "") {
    readBlockEntries(context, node, depth);
  }
}

function readAlias(context: Context, text: string, depth: number): void {
  for (const name of text.matchAll(/\*([^\s,[\]{}]+)/g)) {
    const target = context.anchors.get(name[1] as string);
    if (target !== undefined) readEnvironment(context, target, depth + 1);
  }
}

/** Reads the children of a node whose value starts on the next line. */
function readBlockEntries(context: Context, node: NodeStart, depth: number): void {
  const { lines, scalarLines } = context;
  let childIndent: number | null = null;
  for (let index = node.line + 1; index < lines.length; index += 1) {
    const line = lines[index] as string;
    if (scalarLines.has(index) || isBlank(line)) continue;
    const indent = getIndent(line);
    const isSequenceItem = /^ *- /.test(line) || /^ *-[ \t\r]*$/.test(line);
    if (childIndent === null) {
      if (indent < node.indent || (indent === node.indent && !isSequenceItem)) return;
      childIndent = indent;
    }
    if (indent < childIndent || (indent === node.indent && !isSequenceItem)) return;
    if (indent > childIndent) continue;
    if (isSequenceItem) readSequenceItem(context, index, line.slice(indent + 1).trim());
    else readMappingEntry(context, { line: index, indent, rest: "" }, depth);
  }
}

function readSequenceItem(context: Context, line: number, item: string): void {
  const name = unquote(item);
  if (isPassThroughName(name)) context.emit(name, line);
}

function readMappingEntry(context: Context, entry: NodeStart, depth: number): void {
  const match = KEY_LINE.exec(context.lines[entry.line] as string);
  if (match === null) return;
  const name = getKeyName(match);
  const value = (match[5] ?? "").trim();
  if (name === "<<") {
    readAlias(context, value, depth);
    return;
  }
  if (NULL_VALUE.test(value) && !hasDeeperChild(context, entry) && isPassThroughName(name)) {
    context.emit(name, entry.line);
  }
}

/** Whether the next structural line is indented deeper than `entry`, i.e. holds its value. */
function hasDeeperChild(context: Context, entry: NodeStart): boolean {
  for (let index = entry.line + 1; index < context.lines.length; index += 1) {
    const line = context.lines[index] as string;
    if (isBlank(line)) continue;
    return getIndent(line) > entry.indent;
  }
  return false;
}

/** Reads a flow sequence or mapping that starts on `line`, possibly spanning further lines. */
function readFlowEntries(context: Context, line: number, rest: string): void {
  const isMapping = rest.startsWith("{");
  const close = isMapping ? "}" : "]";
  let text = rest.slice(1);
  let lineIndex = line;
  let current = "";
  let startLine: number | null = null;
  let quote: string | null = null;
  for (;;) {
    for (const char of text) {
      if (quote === null && (char === "," || char === close)) {
        if (startLine !== null) readFlowItem(context, { text: current.trim(), line: startLine }, isMapping);
        if (char === close) return;
        current = "";
        startLine = null;
        continue;
      }
      if (quote !== null && char === quote) quote = null;
      else if (quote === null && (char === '"' || char === "'")) quote = char;
      if (startLine === null && char.trim() !== "") startLine = lineIndex;
      current += char;
    }
    lineIndex += 1;
    if (lineIndex >= context.lines.length) return;
    text = `\n${context.lines[lineIndex]}`;
  }
}

function readFlowItem(context: Context, item: { text: string; line: number }, isMapping: boolean): void {
  const name = isMapping ? getFlowMappingKey(item.text) : unquote(item.text);
  if (name !== null && isPassThroughName(name)) context.emit(name, item.line);
}

/** The key of a flow mapping entry when its value is empty or null; `null` otherwise. */
function getFlowMappingKey(entry: string): string | null {
  const match = /^\s*("[^"]*"|'[^']*'|[^:]+?)\s*(?::(?:\s+(.*?))?)?\s*$/.exec(entry);
  if (match === null) return null;
  return NULL_VALUE.test(match[2] ?? "") ? unquote(match[1] as string) : null;
}

function unquote(text: string): string {
  const match = /^(["'])(.*)\1$/.exec(text);
  return match === null ? text : (match[2] as string);
}

/** A key the host must supply: no value assigned with `=`, no interpolation, no whitespace. */
function isPassThroughName(name: string): boolean {
  return name !== "" && !/[=$\s:{}[\],]/.test(name);
}
