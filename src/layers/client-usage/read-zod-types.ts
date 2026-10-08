import type { Token } from "../persisted-enums/tokenize.js";
import { isPunctuation, type Scan, type TypeMember } from "./read-typescript-client.js";

/** `z.infer` and `z.output` give the parsed value, `z.input` what the schema accepts. */
type Side = "input" | "output";

/** One member of a `z.object({ ... })` and the methods called on it, in order. */
type SchemaMember = {
  name: string;
  line: number;
  base: string;
  calls: { name: string; argument?: Token[] }[];
};

const SIDES: Record<string, Side> = { infer: "output", output: "output", input: "input" };
/** Calls on a `z.object(...)` that keep its members as they are. */
const OBJECT_PRESERVING = new Set(["refine", "superRefine", "strict", "strip", "passthrough", "describe"]);
/** Member schemas that never accept `undefined` or `null` on their own. */
const NON_NULLISH_BASES = new Set([
  "string",
  "number",
  "boolean",
  "bigint",
  "date",
  "array",
  "object",
  "enum",
  "nativeEnum",
  "record",
  "tuple",
  "map",
  "set",
]);
/** Member calls whose result the reader does not follow. */
const UNFOLLOWED_CALLS = new Set(["transform", "pipe", "catch", "or", "and", "promise"]);

/** A schema `const`: its own `z.object` members, or another schema `const` it only refines. */
type SchemaDefinition = { kind: "object"; members: SchemaMember[] } | { kind: "derived"; from: string };

/**
 * `type T = z.infer<typeof s>` (or `z.output`, `z.input`) where `s` is a `const` of the sources
 * initialised with `z.object({ ... })`, or with another such `const`, optionally followed by
 * object-preserving calls: the members of `T` by type name. A member whose schema the reader cannot
 * follow is left out, so it is never proven non-null; a schema with a spread, or declared more than
 * once, gives no type at all.
 */
export function readZodTypes(scans: readonly Scan[]): Map<string, Map<string, TypeMember>> {
  const definitions = new Map<string, SchemaDefinition | undefined>();
  for (const s of scans) {
    for (let index = 0; index < s.tokens.length - 3; index++) {
      if (!isIdentifier(s.tokens[index], "const") || !isIdentifier(s.tokens[index + 1])) continue;
      if (!isPunctuation(s.tokens[index + 2], "=")) continue;
      const name = (s.tokens[index + 1] as Token).text;
      const definition = readSchemaDefinition(s, index + 3);
      if (definition === undefined) continue;
      definitions.set(name, definitions.has(name) ? undefined : definition);
    }
  }
  const schemas = new Map<string, SchemaMember[] | undefined>();
  for (const name of definitions.keys()) schemas.set(name, resolveSchema(definitions, name));
  const types = new Map<string, Map<string, TypeMember>>();
  for (const s of scans) {
    for (let index = 0; index < s.tokens.length; index++) {
      const alias = readAlias(s, index);
      if (alias === undefined) continue;
      const members = schemas.get(alias.schema);
      if (members === undefined || types.has(alias.name)) continue;
      types.set(alias.name, toTypeMembers(members, alias.side));
    }
  }
  return types;
}

function isIdentifier(token: Token | undefined, text?: string): boolean {
  return token?.kind === "identifier" && (text === undefined || token.text === text);
}

/** `type Name = z.<side><typeof schema>` starting at `index`. */
function readAlias(s: Scan, index: number): { name: string; schema: string; side: Side } | undefined {
  const t = s.tokens;
  const isAlias =
    isIdentifier(t[index], "type") &&
    isIdentifier(t[index + 1]) &&
    isPunctuation(t[index + 2], "=") &&
    isIdentifier(t[index + 3], "z") &&
    isPunctuation(t[index + 4], ".") &&
    isPunctuation(t[index + 6], "<") &&
    isIdentifier(t[index + 7], "typeof") &&
    isIdentifier(t[index + 8]) &&
    isPunctuation(t[index + 9], ">");
  const side = SIDES[t[index + 5]?.text ?? ""];
  if (!isAlias || side === undefined) return undefined;
  return { name: (t[index + 1] as Token).text, schema: (t[index + 8] as Token).text, side };
}

/** The members of the schema `name`, following derived schemas once each; `undefined` if they end elsewhere. */
function resolveSchema(
  definitions: ReadonlyMap<string, SchemaDefinition | undefined>,
  name: string,
): SchemaMember[] | undefined {
  const visited = new Set<string>();
  let definition = definitions.get(name);
  while (definition?.kind === "derived" && !visited.has(definition.from)) {
    visited.add(definition.from);
    definition = definitions.get(definition.from);
  }
  return definition?.kind === "object" ? definition.members : undefined;
}

function readSchemaDefinition(s: Scan, start: number): SchemaDefinition | undefined {
  const members = readObjectSchema(s, start);
  if (members !== undefined) return { kind: "object", members };
  const from = readDerivedSchema(s, start);
  return from === undefined ? undefined : { kind: "derived", from };
}

/** `<identifier>` plus object-preserving calls starting at `start`, ending the initialiser: the identifier. */
function readDerivedSchema(s: Scan, start: number): string | undefined {
  const t = s.tokens;
  const from = t[start];
  if (!isIdentifier(from) || isIdentifier(from, "z")) return undefined;
  const chain = readCalls(s, start + 1);
  if (chain === undefined || chain.calls.some((call) => !OBJECT_PRESERVING.has(call.name))) return undefined;
  const next = t[chain.end];
  // Anything else after the chain (a call, an index, an operator, `as`) changes what the value is.
  const isEnd =
    next === undefined ||
    isPunctuation(next, ";") ||
    isPunctuation(next, "}") ||
    (next.kind === "identifier" && next.text !== "as" && next.text !== "satisfies");
  return isEnd ? (from as Token).text : undefined;
}

/** The members of `z.object({ ... })` plus object-preserving calls starting at `start`; `undefined` otherwise. */
function readObjectSchema(s: Scan, start: number): SchemaMember[] | undefined {
  const t = s.tokens;
  const isObject =
    isIdentifier(t[start], "z") &&
    isPunctuation(t[start + 1], ".") &&
    isIdentifier(t[start + 2], "object") &&
    isPunctuation(t[start + 3], "(") &&
    isPunctuation(t[start + 4], "{");
  const open = start + 4;
  const close = s.match[open] ?? -1;
  if (!isObject || close < 0 || !isPunctuation(t[close + 1], ")")) return undefined;
  const chain = readCalls(s, close + 2);
  if (chain === undefined || chain.calls.some((call) => !OBJECT_PRESERVING.has(call.name))) return undefined;
  const members: SchemaMember[] = [];
  for (const item of splitItems(s, open + 1, close)) {
    const key = t[item.start];
    const isProperty =
      (key?.kind === "identifier" || key?.kind === "string") && isPunctuation(t[item.start + 1], ":");
    // A spread or computed key may set any member.
    if (!isProperty) return undefined;
    const member = readMember(s, item.start + 2, item.end);
    if (member === undefined) continue;
    members.push({ name: (key as Token).text, line: (key as Token).line, ...member });
  }
  return members;
}

/** `z.<base>(...)` followed by calls, filling exactly `[start, end)`. */
function readMember(s: Scan, start: number, end: number): Omit<SchemaMember, "name" | "line"> | undefined {
  const t = s.tokens;
  const isBase =
    isIdentifier(t[start], "z") && isPunctuation(t[start + 1], ".") && isIdentifier(t[start + 2]);
  if (!isBase || !isPunctuation(t[start + 3], "(")) return undefined;
  const close = s.match[start + 3] ?? -1;
  if (close < 0) return undefined;
  const chain = readCalls(s, close + 1);
  if (chain === undefined || chain.end !== end) return undefined;
  return { base: (t[start + 2] as Token).text, calls: chain.calls };
}

/** `.name(...)` calls starting at `start`, and the index after the last one. */
function readCalls(s: Scan, start: number): { calls: SchemaMember["calls"]; end: number } | undefined {
  const t = s.tokens;
  const calls: SchemaMember["calls"] = [];
  let cursor = start;
  while (isPunctuation(t[cursor], ".")) {
    if (!isIdentifier(t[cursor + 1]) || !isPunctuation(t[cursor + 2], "(")) return undefined;
    const close = s.match[cursor + 2] ?? -1;
    if (close < 0) return undefined;
    calls.push({ name: (t[cursor + 1] as Token).text, argument: t.slice(cursor + 3, close) });
    cursor = close + 1;
  }
  return { calls, end: cursor };
}

/** The top-level items between `start` and `end`, split at commas. */
function splitItems(s: Scan, start: number, end: number): { start: number; end: number }[] {
  const items: { start: number; end: number }[] = [];
  let itemStart = start;
  for (let index = start; index <= end; index++) {
    const token = s.tokens[index] as Token;
    if (index < end && token.kind === "punctuation" && "([{".includes(token.text)) {
      index = Math.max(index, s.match[index] ?? index);
      continue;
    }
    if (index === end || isPunctuation(token, ",")) {
      if (index > itemStart) items.push({ start: itemStart, end: index });
      itemStart = index + 1;
    }
  }
  return items;
}

/** The members the reader can follow, with what the side of the schema allows for each. */
function toTypeMembers(members: readonly SchemaMember[], side: Side): Map<string, TypeMember> {
  const types = new Map<string, TypeMember>();
  for (const member of members) {
    if (!NON_NULLISH_BASES.has(member.base)) continue;
    if (member.calls.some((call) => UNFOLLOWED_CALLS.has(call.name))) continue;
    let isOptional = false;
    let isNullable = false;
    for (const call of member.calls) {
      if (call.name === "optional" || call.name === "nullish") isOptional = true;
      if (call.name === "nullable" || call.name === "nullish") isNullable = true;
      if (call.name !== "default") continue;
      // A default fills a missing value in the output; the input may still leave it out.
      isOptional = side === "input";
      if (isNullishLiteral(call.argument)) isNullable = true;
    }
    types.set(member.name, { isOptional, isNullable, line: member.line });
  }
  return types;
}

function isNullishLiteral(argument: Token[] | undefined): boolean {
  const [only, ...rest] = argument ?? [];
  return rest.length === 0 && (isIdentifier(only, "null") || isIdentifier(only, "undefined"));
}
