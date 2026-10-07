import { type Token, tokenize } from "../persisted-enums/tokenize.js";
import { HTTP_METHODS, type HttpMethod, normalizePath } from "./paths.js";

/** One HTTP call a generated client can make. `method` is `*` when no method could be read for the path. */
export type ClientOperation = {
  method: HttpMethod | "*";
  /** Normalized path: no query, parameters as `{}`. */
  path: string;
  line: number;
  /** The client function that makes the call, when it could be read. */
  functionName?: string;
  /** The type of the parameter sent as the request body, when it could be read. */
  body?: { typeName: string; isOptional: boolean };
};

export type TypeMember = {
  isOptional: boolean;
  isNullable: boolean;
  /** The named type of the member, arrays unwrapped (`Foo[]`, `Array<Foo>` → `Foo`). */
  typeName?: string;
  line: number;
};

export type ClientModel = {
  operations: ClientOperation[];
  /** Members of every `interface`, `class` and `type X = { ... }`, by type name. */
  types: Map<string, Map<string, TypeMember>>;
};

const OPENERS: Record<string, string> = { "(": ")", "{": "}", "[": "]" };
const MEMBER_MODIFIERS = new Set([
  "public",
  "private",
  "protected",
  "readonly",
  "static",
  "declare",
  "abstract",
  "override",
]);
const NOT_A_DECLARATION = new Set(["if", "for", "while", "switch", "catch", "with", "return", "constructor"]);
const BODY_KEYS = new Set(["body", "data", "json"]);
const PATH_LITERAL = /^\/[A-Za-z0-9_\-.~/{}$?=&%:@]+$/;

type Scan = {
  tokens: Token[];
  /** Index of the matching bracket for `(`, `{`, `[` and their closers; -1 for other tokens. */
  match: Int32Array;
  /** Index of the innermost `{` enclosing each token; -1 at the top level. */
  block: Int32Array;
  /** Index of the innermost `(` enclosing each token; -1 when none. */
  paren: Int32Array;
};

function scan(text: string): Scan {
  const tokens = tokenize(text, "typescript");
  const match = new Int32Array(tokens.length).fill(-1);
  const block = new Int32Array(tokens.length).fill(-1);
  const paren = new Int32Array(tokens.length).fill(-1);
  const stack: number[] = [];
  const braces: number[] = [];
  const parens: number[] = [];
  tokens.forEach((token, index) => {
    block[index] = braces.at(-1) ?? -1;
    paren[index] = parens.at(-1) ?? -1;
    if (token.kind !== "punctuation") return;
    if (OPENERS[token.text] !== undefined) {
      stack.push(index);
      if (token.text === "{") braces.push(index);
      if (token.text === "(") parens.push(index);
      return;
    }
    if (token.text !== ")" && token.text !== "}" && token.text !== "]") return;
    // Unbalanced input: drop openers until the matching kind, so one stray bracket stays local.
    while (stack.length > 0) {
      const open = stack.pop() as number;
      if (tokens[open]?.text === "{") braces.pop();
      if (tokens[open]?.text === "(") parens.pop();
      if (OPENERS[tokens[open]?.text ?? ""] === token.text) {
        match[open] = index;
        match[index] = open;
        break;
      }
    }
  });
  return { tokens, match, block, paren };
}

const isPunctuation = (token: Token | undefined, text: string) =>
  token?.kind === "punctuation" && token.text === text;

function toMethod(text: string | undefined): HttpMethod | undefined {
  const lower = text?.toLowerCase();
  return (HTTP_METHODS as readonly string[]).includes(lower ?? "") ? (lower as HttpMethod) : undefined;
}

/** Skips a generic argument list that ends at `close` (a `>`), returning the index of its `<`. */
function skipGenericBackwards(tokens: Token[], close: number): number {
  let depth = 0;
  for (let index = close; index >= 0; index--) {
    if (isPunctuation(tokens[index], ">")) depth++;
    else if (isPunctuation(tokens[index], "<") && --depth === 0) return index;
  }
  return -1;
}

/** Reads `"/a/" + id + "/b"` starting at a path literal; returns the joined path and the index after it. */
function readConcatenatedPath(s: Scan, start: number): { path: string; end: number } {
  let path = s.tokens[start]?.text ?? "";
  let index = start + 1;
  while (isPunctuation(s.tokens[index], "+")) {
    index++;
    const operand = s.tokens[index];
    if (operand?.kind === "string") {
      path += operand.text;
      index++;
      continue;
    }
    // A non-literal operand is a path parameter; skip it up to the next `+` or the end of the expression.
    path += "{}";
    while (index < s.tokens.length) {
      const token = s.tokens[index] as Token;
      if (token.kind === "punctuation") {
        if (["+", ",", ";", ")", "}", "]"].includes(token.text)) break;
        if (OPENERS[token.text] !== undefined && (s.match[index] ?? -1) > index) {
          index = s.match[index] as number;
        }
      }
      index++;
    }
  }
  return { path, end: index };
}

/** `axios.post("/x")`, `client.POST("/x")`, `this.http.get<T>("/x")`: the method named by the callee. */
function readCalleeMethod(s: Scan, pathIndex: number): HttpMethod | undefined {
  if (!isPunctuation(s.tokens[pathIndex - 1], "(")) return undefined;
  let callee = pathIndex - 2;
  if (isPunctuation(s.tokens[callee], ">")) callee = skipGenericBackwards(s.tokens, callee) - 1;
  const token = s.tokens[callee];
  return token?.kind === "identifier" ? toMethod(token.text) : undefined;
}

/** Methods declared under an openapi-typescript `paths` key: `"/x": { get: ...; put?: never }`. */
function readPathsKeyMethods(s: Scan, pathIndex: number): HttpMethod[] | undefined {
  if (!isPunctuation(s.tokens[pathIndex + 1], ":") || !isPunctuation(s.tokens[pathIndex + 2], "{")) {
    return undefined;
  }
  const open = pathIndex + 2;
  const close = s.match[open] ?? -1;
  if (close < 0) return undefined;
  const methods: HttpMethod[] = [];
  for (let index = open + 1; index < close; index++) {
    if (s.block[index] !== open) continue;
    const method = s.tokens[index]?.kind === "identifier" ? toMethod(s.tokens[index]?.text) : undefined;
    if (method === undefined) continue;
    let next = index + 1;
    if (isPunctuation(s.tokens[next], "?")) next++;
    if (!isPunctuation(s.tokens[next], ":")) continue;
    if (s.tokens[next + 1]?.kind === "identifier" && s.tokens[next + 1]?.text === "never") continue;
    methods.push(method);
  }
  return methods;
}

/** `method: "POST"`, `method = "POST"` or `request("post", ...)` inside a block, nearest to `near` first. */
function findMethodInBlock(s: Scan, open: number, near: number): HttpMethod | undefined {
  const close = open < 0 ? s.tokens.length : (s.match[open] ?? -1);
  if (close < 0) return undefined;
  let best: { method: HttpMethod; distance: number } | undefined;
  for (let index = open + 1; index < close; index++) {
    const token = s.tokens[index] as Token;
    if (token.kind !== "string") continue;
    const method = toMethod(token.text);
    if (method === undefined) continue;
    const previous = s.tokens[index - 1];
    const isKeyed =
      (isPunctuation(previous, ":") || isPunctuation(previous, "=")) &&
      s.tokens[index - 2]?.kind === "identifier" &&
      s.tokens[index - 2]?.text === "method";
    const isFirstArgument =
      isPunctuation(previous, "(") &&
      s.tokens[index - 2]?.kind === "identifier" &&
      s.tokens[index - 2]?.text === "request";
    if (!isKeyed && !isFirstArgument) continue;
    const distance = Math.abs(index - near);
    if (best === undefined || distance < best.distance) best = { method, distance };
  }
  return best?.method;
}

function countPathLiterals(s: Scan, open: number): number {
  const close = s.match[open] ?? -1;
  let count = 0;
  for (let index = open + 1; index < close; index++) {
    if (isPathLiteral(s.tokens[index])) count++;
  }
  return count;
}

function isPathLiteral(token: Token | undefined): boolean {
  return token?.kind === "string" && token.text.length > 1 && PATH_LITERAL.test(token.text);
}

/**
 * The method for a path literal from the code around it: the call it is an argument of
 * (`fetch("/x", { method })`), then its own block, then the block enclosing that one.
 */
function readBlockMethod(s: Scan, pathIndex: number): HttpMethod | undefined {
  const inner = s.block[pathIndex] ?? -1;
  const call = s.paren[pathIndex] ?? -1;
  if (call > inner) {
    const argument = findMethodInBlock(s, call, pathIndex);
    if (argument !== undefined) return argument;
  }
  if (inner < 0) return undefined;
  const own = findMethodInBlock(s, inner, pathIndex);
  if (own !== undefined) return own;
  const outer = s.block[inner] ?? -1;
  if (outer < 0 || countPathLiterals(s, outer) > 1) return undefined;
  return findMethodInBlock(s, outer, pathIndex);
}

type Declaration = { name: string; paramsOpen: number; paramsClose: number; end: number };

/**
 * The nearest function or method declared before `index` that contains it: `name(...) {`,
 * `name(...): T {`, `function name(...)`, `name = (...) =>`, `name: async (...) =>`.
 */
function findDeclaration(s: Scan, index: number): Declaration | undefined {
  for (let open = index - 1; open >= 0; open--) {
    if (!isPunctuation(s.tokens[open], "(")) continue;
    const close = s.match[open] ?? -1;
    if (close < 0 || close >= index) continue;
    const after = s.tokens[close + 1];
    const isBody = isPunctuation(after, "{");
    if (!isBody && !isPunctuation(after, "=>") && !isPunctuation(after, ":")) continue;
    if (isBody && (s.match[close + 1] ?? -1) < index) continue;
    let nameIndex = open - 1;
    if (isPunctuation(s.tokens[nameIndex], ">")) nameIndex = skipGenericBackwards(s.tokens, nameIndex) - 1;
    if (s.tokens[nameIndex]?.text === "async") nameIndex--;
    if (isPunctuation(s.tokens[nameIndex], "=") || isPunctuation(s.tokens[nameIndex], ":")) nameIndex--;
    const name = s.tokens[nameIndex];
    if (name?.kind !== "identifier" || NOT_A_DECLARATION.has(name.text)) continue;
    const end = isBody ? (s.match[close + 1] as number) : s.tokens.length;
    return { name: name.text, paramsOpen: open, paramsClose: close, end };
  }
  return undefined;
}

type Parameter = { name: string; isOptional: boolean; typeTokens: Token[] };

/** Splits `(a: string, body?: Foo | undefined, ...)` into parameters. */
function readParameters(s: Scan, open: number, close: number): Parameter[] {
  const parameters: Parameter[] = [];
  let index = open + 1;
  while (index < close) {
    while (MEMBER_MODIFIERS.has(s.tokens[index]?.text ?? "")) index++;
    const name = s.tokens[index];
    const end = findListEnd(s, index, close);
    if (name?.kind === "identifier") {
      let cursor = index + 1;
      const isOptional = isPunctuation(s.tokens[cursor], "?");
      if (isOptional) cursor++;
      const typeTokens = isPunctuation(s.tokens[cursor], ":") ? s.tokens.slice(cursor + 1, end) : [];
      const defaultAt = typeTokens.findIndex((token) => isPunctuation(token, "="));
      parameters.push({
        name: name.text,
        isOptional: isOptional || defaultAt >= 0,
        typeTokens: defaultAt >= 0 ? typeTokens.slice(0, defaultAt) : typeTokens,
      });
    }
    index = end + 1;
  }
  return parameters;
}

/** Index of the `,` ending a list item that starts at `start`, or `close`; skips brackets and generics. */
function findListEnd(s: Scan, start: number, close: number): number {
  let angles = 0;
  for (let index = start; index < close; index++) {
    const token = s.tokens[index] as Token;
    if (token.kind !== "punctuation") continue;
    if (OPENERS[token.text] !== undefined && (s.match[index] ?? -1) > index) {
      index = s.match[index] as number;
      continue;
    }
    if (token.text === "<") angles++;
    else if (token.text === ">" && angles > 0) angles--;
    else if (token.text === "," && angles === 0) return index;
  }
  return close;
}

type TypeShape = { typeName?: string; isNullable: boolean; isUndefinable: boolean };

/** Reads `Foo`, `Foo[]`, `Array<Foo>`, `Foo | null | undefined`; anything else has no type name. */
function readTypeShape(tokens: Token[]): TypeShape {
  const isNullable = tokens.some((token) => token.kind === "identifier" && token.text === "null");
  const isUndefinable = tokens.some((token) => token.kind === "identifier" && token.text === "undefined");
  const alternatives: Token[][] = [[]];
  for (const token of tokens) {
    if (isPunctuation(token, "|")) alternatives.push([]);
    else alternatives.at(-1)?.push(token);
  }
  const named = alternatives.filter(
    (alternative) =>
      alternative.length > 0 &&
      !(alternative.length === 1 && ["null", "undefined"].includes(alternative[0]?.text ?? "")),
  );
  if (named.length !== 1) return { isNullable, isUndefinable };
  const texts = (named[0] as Token[]).map((token) => token.text);
  const [first] = texts;
  if (first === undefined || (named[0] as Token[])[0]?.kind !== "identifier")
    return { isNullable, isUndefinable };
  if (texts.length === 1) return { typeName: first, isNullable, isUndefinable };
  if (texts.length === 3 && texts[1] === "[" && texts[2] === "]")
    return { typeName: first, isNullable, isUndefinable };
  if (texts.length === 4 && first === "Array" && texts[1] === "<" && texts[3] === ">") {
    return { typeName: texts[2], isNullable, isUndefinable };
  }
  return { isNullable, isUndefinable };
}

/** Which parameter a call sends as its body: one named in `JSON.stringify(x)`, `data: x`, `body: x`, or one called `body`. */
function readBody(s: Scan, declaration: Declaration): ClientOperation["body"] {
  const parameters = readParameters(s, declaration.paramsOpen, declaration.paramsClose);
  const names = new Set(parameters.map((parameter) => parameter.name));
  let sent: string | undefined;
  for (let index = declaration.paramsClose + 1; index < declaration.end && sent === undefined; index++) {
    const token = s.tokens[index] as Token;
    if (token.kind !== "identifier" || !names.has(token.text)) continue;
    const previous = s.tokens[index - 1];
    const isStringified =
      isPunctuation(previous, "(") &&
      s.tokens[index - 2]?.text === "stringify" &&
      isPunctuation(s.tokens[index + 1], ")");
    const isKeyed = isPunctuation(previous, ":") && BODY_KEYS.has(s.tokens[index - 2]?.text ?? "");
    if (isStringified || isKeyed) sent = token.text;
  }
  const parameter = parameters.find((candidate) => candidate.name === (sent ?? "body"));
  if (parameter === undefined) return undefined;
  const shape = readTypeShape(parameter.typeTokens);
  if (shape.typeName === undefined) return undefined;
  return {
    typeName: shape.typeName,
    isOptional: parameter.isOptional || shape.isUndefinable || shape.isNullable,
  };
}

function readOperations(s: Scan): ClientOperation[] {
  const operations: ClientOperation[] = [];
  // Literals inside a concatenation already read are not operations of their own.
  let consumedUntil = 0;
  for (let index = 0; index < s.tokens.length; index++) {
    const token = s.tokens[index] as Token;
    if (index < consumedUntil || !isPathLiteral(token)) continue;
    const concatenated = readConcatenatedPath(s, index);
    consumedUntil = concatenated.end;
    const path = normalizePath(concatenated.path);
    const keyed = readPathsKeyMethods(s, index);
    if (keyed !== undefined) {
      const methods: (HttpMethod | "*")[] = keyed.length > 0 ? keyed : ["*"];
      for (const method of methods) operations.push({ method, path, line: token.line });
      continue;
    }
    const method = readCalleeMethod(s, index) ?? readBlockMethod(s, index) ?? "*";
    const operation: ClientOperation = { method, path, line: token.line };
    const declaration = findDeclaration(s, index);
    if (declaration !== undefined) {
      operation.functionName = declaration.name;
      const body = readBody(s, declaration);
      if (body !== undefined) operation.body = body;
    }
    operations.push(operation);
  }
  return operations;
}

/** Index after the member that starts at `start` inside a type body closing at `close`. */
function skipMember(s: Scan, start: number, close: number): number {
  let angles = 0;
  for (let index = start; index < close; index++) {
    const token = s.tokens[index] as Token;
    if (token.kind !== "punctuation") continue;
    if (token.text === "{" && angles === 0 && index > start) {
      return (s.match[index] ?? close) + 1;
    }
    if (OPENERS[token.text] !== undefined && (s.match[index] ?? -1) > index) {
      index = s.match[index] as number;
      continue;
    }
    if (token.text === "<") angles++;
    else if (token.text === ">" && angles > 0) angles--;
    else if ((token.text === ";" || token.text === ",") && angles === 0) return index + 1;
  }
  return close;
}

/** End of a member's type: `;` or `,` at depth zero, the closing brace, or a new line starting the next member. */
function findTypeEnd(s: Scan, start: number, close: number): number {
  let angles = 0;
  for (let index = start; index < close; index++) {
    const token = s.tokens[index] as Token;
    const previous = s.tokens[index - 1] as Token;
    if (index > start && token.line > previous.line && angles === 0 && isMemberStart(s, index)) {
      const continues =
        previous.kind === "punctuation" && ["|", "&", "<", ",", ":", "=>"].includes(previous.text);
      if (!continues) return index;
    }
    if (token.kind !== "punctuation") continue;
    if (OPENERS[token.text] !== undefined && (s.match[index] ?? -1) > index) {
      index = s.match[index] as number;
      continue;
    }
    if (token.text === "<") angles++;
    else if (token.text === ">" && angles > 0) angles--;
    else if ((token.text === ";" || token.text === ",") && angles === 0) return index;
  }
  return close;
}

function isMemberStart(s: Scan, index: number): boolean {
  let cursor = index;
  while (MEMBER_MODIFIERS.has(s.tokens[cursor]?.text ?? "")) cursor++;
  const name = s.tokens[cursor];
  if (name?.kind !== "identifier" && name?.kind !== "string") return false;
  const next = s.tokens[cursor + 1];
  return (
    isPunctuation(next, ":") ||
    isPunctuation(next, "?") ||
    isPunctuation(next, "!") ||
    isPunctuation(next, "(")
  );
}

function readMembers(s: Scan, open: number): Map<string, TypeMember> {
  const close = s.match[open] ?? -1;
  const members = new Map<string, TypeMember>();
  let index = open + 1;
  while (index < close && index >= 0) {
    while (MEMBER_MODIFIERS.has(s.tokens[index]?.text ?? "")) index++;
    const name = s.tokens[index];
    let cursor = index + 1;
    const isOptional = isPunctuation(s.tokens[cursor], "?");
    if (isOptional || isPunctuation(s.tokens[cursor], "!")) cursor++;
    const isProperty =
      (name?.kind === "identifier" || name?.kind === "string") && isPunctuation(s.tokens[cursor], ":");
    if (!isProperty) {
      index = skipMember(s, index, close);
      continue;
    }
    const end = findTypeEnd(s, cursor + 1, close);
    const shape = readTypeShape(s.tokens.slice(cursor + 1, end));
    const member: TypeMember = {
      isOptional: isOptional || shape.isUndefinable,
      isNullable: shape.isNullable,
      line: (name as Token).line,
    };
    if (shape.typeName !== undefined) member.typeName = shape.typeName;
    members.set((name as Token).text, member);
    index = isPunctuation(s.tokens[end], ";") || isPunctuation(s.tokens[end], ",") ? end + 1 : end;
  }
  return members;
}

/** `interface X ... {`, `class X ... {`, `type X = {`: the type name and the index of its `{`. */
function readTypes(s: Scan): Map<string, Map<string, TypeMember>> {
  const types = new Map<string, Map<string, TypeMember>>();
  for (let index = 0; index < s.tokens.length; index++) {
    const keyword = s.tokens[index] as Token;
    const name = s.tokens[index + 1];
    if (keyword.kind !== "identifier" || name?.kind !== "identifier") continue;
    let open = -1;
    if (keyword.text === "type") {
      let cursor = index + 2;
      if (isPunctuation(s.tokens[cursor], "<")) cursor = findGenericEnd(s.tokens, cursor) + 1;
      if (isPunctuation(s.tokens[cursor], "=") && isPunctuation(s.tokens[cursor + 1], "{")) open = cursor + 1;
    } else if (keyword.text === "interface" || keyword.text === "class") {
      for (let cursor = index + 2; cursor < s.tokens.length; cursor++) {
        const token = s.tokens[cursor] as Token;
        if (isPunctuation(token, "{")) {
          open = cursor;
          break;
        }
        if (isPunctuation(token, ";") || isPunctuation(token, "}")) break;
      }
    }
    if (open < 0 || (s.match[open] ?? -1) < 0 || types.has(name.text)) continue;
    types.set(name.text, readMembers(s, open));
  }
  return types;
}

function findGenericEnd(tokens: Token[], open: number): number {
  let depth = 0;
  for (let index = open; index < tokens.length; index++) {
    if (isPunctuation(tokens[index], "<")) depth++;
    else if (isPunctuation(tokens[index], ">") && --depth === 0) return index;
  }
  return tokens.length;
}

/**
 * Reads a generated TypeScript client (NSwag, swaggie, orval, axios or fetch style, openapi-typescript
 * `paths`). Every path literal becomes an operation; one whose method cannot be read gets `*`, so a
 * reader miss counts as "called", never as "not called".
 */
export function readTypescriptClient(text: string): ClientModel {
  const s = scan(text);
  return { operations: readOperations(s), types: readTypes(s) };
}

/** Every identifier in a TypeScript source, for finding which client functions it references. */
export function readIdentifiers(text: string): Set<string> {
  const identifiers = new Set<string>();
  for (const token of tokenize(text, "typescript")) {
    if (token.kind === "identifier") identifiers.add(token.text);
  }
  return identifiers;
}
