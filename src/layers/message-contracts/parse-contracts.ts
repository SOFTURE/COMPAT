import { type EnumDeclaration, parseEnums } from "../persisted-enums/parse-enums.js";
import { type Token, tokenize } from "../persisted-enums/tokenize.js";

export const CONTRACT_KINDS = ["class", "record", "record struct", "struct", "interface"] as const;

export type ContractKind = (typeof CONTRACT_KINDS)[number];

export type ContractProperty = {
  /** The C# member name. */
  name: string;
  /** The name on the wire: `[JsonPropertyName("x")]`, else the member name. */
  wireName: string;
  /** Normalized type text: no trivia, `global::` and `System.` qualifiers dropped, `Nullable<T>` as `T?`. */
  type: string;
  /** An initializer (`= x`) or a positional parameter default. */
  hasDefault: boolean;
  /** Declared `required` or `[JsonRequired]`: a message without it fails to deserialize. */
  isRequired: boolean;
  line: number;
};

export type ContractType = {
  /** `Namespace.Outer+Inner`, generic arity as `` `N ``, as in a MassTransit message URN. */
  fullName: string;
  /** The name without namespace and enclosing types, with arity: `Envelope`1`. */
  simpleName: string;
  kind: ContractKind;
  line: number;
  isPartial: boolean;
  /** `[MessageUrn("...")]`: replaces the URN derived from the full name. */
  urn: string | null;
  /** `[EntityName("...")]`: the exchange or topic the message is published to. */
  entityName: string | null;
  /** Base types and interfaces, normalized like property types. */
  baseTypes: string[];
  properties: ContractProperty[];
};

export type ContractEnum = { fullName: string; declaration: EnumDeclaration };

/** A declaration the parser found but could not read; its contract cannot be compared. */
export type ContractFailure = { name: string; line: number; error: string };

export type ParsedContracts = {
  /** Public, non-static classes, records, structs and interfaces, nested ones included. */
  types: ContractType[];
  /** Public enums. */
  enums: ContractEnum[];
  failures: ContractFailure[];
};

type Scope = {
  namespace: string;
  /** The enclosing type, or `null` at namespace level. */
  outer: { fullName: string; kind: ContractKind | "enum"; isPublic: boolean } | null;
};

const MODIFIERS = new Set([
  "public",
  "private",
  "protected",
  "internal",
  "file",
  "static",
  "readonly",
  "sealed",
  "abstract",
  "virtual",
  "override",
  "new",
  "partial",
  "required",
  "const",
  "volatile",
  "unsafe",
  "extern",
  "async",
  "fixed",
  "ref",
  "scoped",
]);
const PARAMETER_MODIFIERS = new Set(["this", "params", "in", "ref", "out", "scoped", "readonly"]);
const SKIPPED_MEMBER_KEYWORDS = new Set(["delegate", "event", "operator", "implicit", "explicit"]);
const TYPE_KEYWORDS = new Set(["class", "struct", "interface", "record", "enum"]);
const SYSTEM_ALIASES: Record<string, string> = {
  String: "string",
  Object: "object",
  Boolean: "bool",
  Byte: "byte",
  SByte: "sbyte",
  Char: "char",
  Decimal: "decimal",
  Double: "double",
  Single: "float",
  Int16: "short",
  Int32: "int",
  Int64: "long",
  UInt16: "ushort",
  UInt32: "uint",
  UInt64: "ulong",
};
const OPENERS: Record<string, string> = { "(": ")", "[": "]", "{": "}" };

/**
 * A declaration-looking line (`public sealed record Foo`, `enum Bar`), comments excluded. Any such
 * name the parser did not walk past means a lost declaration, which must fail, never read as absent.
 */
const DECLARATION_LINE =
  /^[ \t]*(?:\[[^\]\n]*\][ \t]*)*(?:(?:public|internal|private|protected|file|static|sealed|abstract|partial|readonly|ref|unsafe|new)[ \t]+)*(?:record[ \t]+(?:class|struct)|record|class|struct|interface|enum)[ \t]+@?([A-Za-z_][A-Za-z0-9_]*)\b/gm;

/** Finds the contract types and enums declared in one C# file. Pure; never throws. */
export function parseContracts(text: string): ParsedContracts {
  const comments: [number, number][] = [];
  const tokens = tokenize(text, "csharp", (start, end) => comments.push([start, end]));
  const isInComment = (offset: number) => comments.some(([start, end]) => offset >= start && offset < end);
  const enums = parseEnums(text, "csharp");
  const result: ParsedContracts = { types: [], enums: [], failures: [] };
  /** Every declared name the walk reached, public or not, for the safety net. */
  const walked = new Set<string>();

  const fail = (name: string, line: number, error: string) =>
    result.failures.push({ name, line, error: `"${name}" at line ${line} ${error}` });

  walkMembers(0, tokens.length, { namespace: "", outer: null }, null);
  // A commented-out declaration is none; one inside a string or after a lost literal still counts (fail closed).
  for (const match of text.matchAll(DECLARATION_LINE)) {
    const name = match[1] as string;
    if (isInComment(match.index + match[0].length - 1)) continue;
    if (walked.has(name)) continue;
    walked.add(name);
    const line = getLineAt(text, match.index + match[0].length - name.length);
    fail(name, line, "was not recognised by the parser");
  }
  return result;

  /**
   * Walks the members of a namespace (`sink` is `null`) or of a type body (`sink` collects its
   * properties and errors) between `start` and `end` (exclusive). Returns `true` when parsing had to
   * stop at unbalanced brackets; nothing after them can be trusted.
   */
  function walkMembers(
    start: number,
    end: number,
    scope: Scope,
    sink: { properties: ContractProperty[]; errors: string[] } | null,
  ): boolean {
    let namespace = scope.namespace;
    let index = start;
    while (index < end) {
      const token = tokens[index] as Token;
      if (token.kind === "directive") {
        if (sink !== null) sink.errors.push(`has a #${token.text} at line ${token.line}`);
        index++;
        continue;
      }
      if (scope.outer === null && token.kind === "identifier" && token.text === "namespace") {
        const nameEnd = findNameEnd(index + 1, end);
        const name = joinText(tokens.slice(index + 1, nameEnd));
        const qualified = namespace === "" ? name : `${namespace}.${name}`;
        const next = tokens[nameEnd];
        if (next?.text === ";") {
          namespace = qualified;
          index = nameEnd + 1;
          continue;
        }
        if (next?.text === "{") {
          const close = findClose(nameEnd, end);
          if (close === null) return stop(token);
          if (walkMembers(nameEnd + 1, close, { namespace: qualified, outer: null }, null)) return true;
          index = close + 1;
          continue;
        }
        index = nameEnd;
        continue;
      }
      if (scope.outer === null && token.text === "[" && tokens[index + 2]?.text === ":") {
        // A global attribute such as `[assembly: InternalsVisibleTo("x")]`.
        const close = findClose(index, end);
        if (close === null) return stop(token);
        index = close + 1;
        continue;
      }
      const memberEnd = findMemberEnd(index, end);
      if (memberEnd === null) return stop(token);
      const stopped = readMember(index, memberEnd, { namespace, outer: scope.outer }, sink);
      if (stopped) return true;
      index = memberEnd;
    }
    return false;
  }

  function stop(token: Token): boolean {
    result.failures.push({
      name: "(file)",
      line: token.line,
      error: `unbalanced brackets after line ${token.line}; the rest of the file cannot be read`,
    });
    return true;
  }

  /** End (exclusive) of the member starting at `start`, or `null` when a block is never closed. */
  function findMemberEnd(start: number, end: number): number | null {
    let isAssigned = false;
    let index = start;
    while (index < end) {
      const token = tokens[index] as Token;
      if (token.kind === "directive") return index === start ? index + 1 : index;
      if (token.kind === "punctuation") {
        if (token.text === ";") return index + 1;
        if (token.text === "=" || token.text === "=>") isAssigned = true;
        if (token.text === "(" || token.text === "[") {
          const close = findClose(index, end);
          if (close === null) return null;
          index = close + 1;
          continue;
        }
        if (token.text === "{") {
          const close = findClose(index, end);
          if (close === null) return null;
          // A block ends the member unless it is part of an initializer or a property with one.
          if (!isAssigned && tokens[close + 1]?.text !== "=") return close + 1;
          index = close + 1;
          continue;
        }
        if (token.text === "}") return index + 1;
      }
      index++;
    }
    return end;
  }

  /** Index of the bracket closing the one at `open`, or `null`. Nested brackets of any kind are skipped. */
  function findClose(open: number, end: number): number | null {
    const stack: string[] = [];
    for (let index = open; index < end; index++) {
      const token = tokens[index] as Token;
      if (token.kind !== "punctuation") continue;
      const closer = OPENERS[token.text];
      if (closer !== undefined) {
        stack.push(closer);
        continue;
      }
      if (token.text === ")" || token.text === "]" || token.text === "}") {
        if (stack.pop() !== token.text) return null;
        if (stack.length === 0) return index;
      }
    }
    return null;
  }

  function findNameEnd(start: number, end: number): number {
    let index = start;
    while (index < end && (tokens[index]?.kind === "identifier" || tokens[index]?.text === ".")) index++;
    return index;
  }

  /** Reads one member; returns `true` when parsing must stop. */
  function readMember(
    start: number,
    end: number,
    scope: Scope,
    sink: { properties: ContractProperty[]; errors: string[] } | null,
  ): boolean {
    const attributes: Token[][] = [];
    let index = skipAttributes(start, end, attributes);
    const modifiers = new Set<string>();
    while (
      index < end &&
      tokens[index]?.kind === "identifier" &&
      MODIFIERS.has(tokens[index]?.text as string)
    ) {
      // `ref struct` is a type, `ref int X` a member; both just carry the modifier.
      modifiers.add((tokens[index] as Token).text);
      index++;
    }
    const head = tokens[index];
    if (head === undefined || index >= end) return false;
    if (
      head.kind === "identifier" &&
      TYPE_KEYWORDS.has(head.text) &&
      tokens[index + 1]?.kind === "identifier"
    ) {
      return readType({ start: index, end, scope, modifiers, attributes });
    }
    if (sink === null) return false;
    if (head.kind === "punctuation" && (head.text === ";" || head.text === "~")) return false;
    if (head.kind === "identifier" && SKIPPED_MEMBER_KEYWORDS.has(head.text)) return false;
    if (modifiers.has("const")) return false;
    const isInterface = scope.outer?.kind === "interface";
    const isPublic =
      modifiers.has("public") ||
      (isInterface && !modifiers.has("private") && !modifiers.has("protected") && !modifiers.has("internal"));
    const typeEnd = skipType(index, end);
    const nameToken = typeEnd === null ? undefined : tokens[typeEnd];
    const unreadable = () => {
      if (isPublic) sink.errors.push(`has an unreadable member at line ${head.line}`);
      return false;
    };
    if (typeEnd === null || nameToken === undefined) return unreadable();
    // A constructor: the "type" was the name and a parameter list follows.
    if (nameToken.text === "(") return false;
    if (nameToken.kind !== "identifier") return unreadable();
    if (nameToken.text === "this" || nameToken.text === "operator") return false;
    const after = tokens[typeEnd + 1];
    // An explicit interface member (`IFoo.Bar`), a method or a generic method.
    if (after?.text === "." || after?.text === "(" || after?.text === "<") return false;
    // A field or an expression-bodied (computed) property: no wire data.
    if (after?.text === ";" || after?.text === "=" || after?.text === "," || after?.text === "=>")
      return false;
    if (after?.text !== "{") return unreadable();
    if (!isPublic || modifiers.has("static")) return false;
    const close = findClose(typeEnd + 1, end);
    if (close === null) return unreadable();
    const accessors = tokens.slice(typeEnd + 2, close);
    // A set-only property, or one whose getter is not public, is never serialized.
    const getter = accessors.findIndex((token) => token.kind === "identifier" && token.text === "get");
    const getterModifier = accessors[getter - 1];
    if (getter === -1) return false;
    if (getterModifier?.kind === "identifier" && MODIFIERS.has(getterModifier.text)) return false;
    const wire = readWireAttributes(attributes, false);
    if (wire.error !== null) {
      sink.errors.push(`property "${nameToken.text}" at line ${nameToken.line} ${wire.error}`);
      return false;
    }
    if (wire.isIgnored) return false;
    const hasInitializer = tokens[close + 1]?.text === "=";
    sink.properties.push({
      name: nameToken.text,
      wireName: wire.name ?? nameToken.text,
      type: formatType(tokens.slice(index, typeEnd)),
      hasDefault: hasInitializer && isRealDefault(tokens.slice(close + 2, end).filter((t) => t.text !== ";")),
      isRequired: modifiers.has("required") || wire.isRequired,
      line: nameToken.line,
    });
    return false;
  }

  /** Reads a type declaration whose keyword is at `start`; returns `true` when parsing must stop. */
  function readType({ start, end, scope, modifiers, attributes }: TypeHead): boolean {
    const keyword = tokens[start] as Token;
    let index = start + 1;
    let kind: ContractKind | "enum" = keyword.text as ContractKind | "enum";
    if (keyword.text === "record" && (tokens[index]?.text === "class" || tokens[index]?.text === "struct")) {
      kind = tokens[index]?.text === "struct" ? "record struct" : "record";
      index++;
    }
    const nameToken = tokens[index] as Token;
    walked.add(nameToken.text);
    index++;
    let arity = 0;
    if (tokens[index]?.text === "<") {
      const close = skipAngles(index, end);
      if (close === null) {
        fail(nameToken.text, keyword.line, "has an unclosed type parameter list");
        return false;
      }
      arity = countTopLevelCommas(index + 1, close) + 1;
      index = close + 1;
    }
    const simpleName = arity > 0 ? `${nameToken.text}\`${arity}` : nameToken.text;
    const isNested = scope.outer !== null;
    const isPublic =
      (scope.outer === null || scope.outer.isPublic) &&
      (modifiers.has("public") ||
        (scope.outer?.kind === "interface" &&
          !modifiers.has("private") &&
          !modifiers.has("protected") &&
          !modifiers.has("internal")));
    const fullName = isNested
      ? `${scope.outer?.fullName}+${simpleName}`
      : scope.namespace === ""
        ? simpleName
        : `${scope.namespace}.${simpleName}`;

    if (kind === "enum") {
      if (!isPublic) return false;
      const declaration = enums.declarations.find(
        (candidate) => candidate.name === nameToken.text && candidate.line === keyword.line,
      );
      if (declaration !== undefined) {
        result.enums.push({ fullName, declaration });
        return false;
      }
      const failure = enums.failures.find(
        (candidate) => candidate.name === nameToken.text && candidate.line === keyword.line,
      );
      result.failures.push({
        name: nameToken.text,
        line: keyword.line,
        error:
          failure?.error ??
          `enum "${nameToken.text}" at line ${keyword.line} was not recognised by the parser`,
      });
      return false;
    }

    const parameters: { start: number; end: number } | null =
      tokens[index]?.text === "(" ? { start: index, end: findClose(index, end) ?? -1 } : null;
    if (parameters !== null) {
      if (parameters.end === -1) {
        fail(fullName, keyword.line, "has an unclosed parameter list");
        return true;
      }
      index = parameters.end + 1;
    }
    const baseTypes: string[] = [];
    if (tokens[index]?.text === ":") {
      index++;
      let baseStart = index;
      while (index < end) {
        const token = tokens[index] as Token;
        if (
          token.text === "{" ||
          token.text === ";" ||
          (token.kind === "identifier" && token.text === "where")
        )
          break;
        if (token.text === "<") {
          index = (skipAngles(index, end) ?? end - 1) + 1;
          continue;
        }
        if (token.text === "(") {
          // Arguments passed to the base record's constructor: `: Base(Id)`.
          const close = findClose(index, end) ?? end - 1;
          baseTypes.push(formatType(tokens.slice(baseStart, index)));
          baseStart = -1;
          index = close + 1;
          continue;
        }
        if (token.text === ",") {
          if (baseStart !== -1) baseTypes.push(formatType(tokens.slice(baseStart, index)));
          baseStart = index + 1;
        }
        index++;
      }
      if (baseStart !== -1 && baseStart < index) baseTypes.push(formatType(tokens.slice(baseStart, index)));
    }
    while (index < end && tokens[index]?.text !== "{" && tokens[index]?.text !== ";") index++;

    const sink = { properties: [] as ContractProperty[], errors: [] as string[] };
    const isRecord = kind === "record" || kind === "record struct";
    if (parameters !== null && isRecord) {
      readPositionalParameters(parameters.start + 1, parameters.end, sink);
    }
    if (tokens[index]?.text === "{") {
      const close = findClose(index, end);
      if (close === null) {
        fail(fullName, keyword.line, "has no closing brace");
        return true;
      }
      const inner: Scope = { namespace: scope.namespace, outer: { fullName, kind, isPublic } };
      if (walkMembers(index + 1, close, inner, sink)) return true;
    } else if (tokens[index]?.text !== ";") {
      if (isPublic) fail(fullName, keyword.line, "has no body");
      return false;
    }
    if (!isPublic || modifiers.has("static")) return false;
    const identity = readIdentityAttributes(attributes);
    if (identity.error !== null) sink.errors.push(identity.error);
    if (sink.errors.length > 0) {
      fail(fullName, keyword.line, sink.errors.join("; "));
      return false;
    }
    // A body property declared with the name of a positional parameter replaces the generated one.
    const byName = new Map<string, ContractProperty>();
    for (const property of sink.properties) byName.set(property.name, property);
    result.types.push({
      fullName,
      simpleName,
      kind,
      line: keyword.line,
      isPartial: modifiers.has("partial"),
      urn: identity.urn,
      entityName: identity.entityName,
      baseTypes,
      properties: [...byName.values()],
    });
    return false;
  }

  /** The positional parameters of a record, which become its public properties. */
  function readPositionalParameters(
    start: number,
    end: number,
    sink: { properties: ContractProperty[]; errors: string[] },
  ): void {
    for (const [segmentStart, segmentEnd] of splitTopLevel(start, end)) {
      const attributes: Token[][] = [];
      let index = skipAttributes(segmentStart, segmentEnd, attributes);
      while (index < segmentEnd && PARAMETER_MODIFIERS.has(tokens[index]?.text as string)) index++;
      const typeEnd = skipType(index, segmentEnd);
      const nameToken = typeEnd === null ? undefined : tokens[typeEnd];
      const isDefaulted = typeEnd !== null && tokens[typeEnd + 1]?.text === "=";
      const isComplete = typeEnd !== null && (typeEnd + 1 === segmentEnd || isDefaulted);
      if (nameToken?.kind !== "identifier" || !isComplete || typeEnd === null) {
        sink.errors.push(`has an unreadable positional parameter at line ${tokens[segmentStart]?.line}`);
        continue;
      }
      const wire = readWireAttributes(attributes, true);
      if (wire.error !== null) {
        sink.errors.push(`positional parameter "${nameToken.text}" at line ${nameToken.line} ${wire.error}`);
        continue;
      }
      if (wire.isIgnored) continue;
      sink.properties.push({
        name: nameToken.text,
        wireName: wire.name ?? nameToken.text,
        type: formatType(tokens.slice(index, typeEnd)),
        hasDefault: isDefaulted && isRealDefault(tokens.slice(typeEnd + 2, segmentEnd)),
        isRequired: wire.isRequired,
        line: nameToken.line,
      });
    }
  }

  /** `[start, end)` ranges between top-level commas. */
  function splitTopLevel(start: number, end: number): [number, number][] {
    const ranges: [number, number][] = [];
    let segmentStart = start;
    let index = start;
    while (index < end) {
      const token = tokens[index] as Token;
      if (OPENERS[token.text] !== undefined && token.kind === "punctuation") {
        index = (findClose(index, end) ?? end - 1) + 1;
        continue;
      }
      if (token.text === "<") {
        index = (skipAngles(index, end) ?? end - 1) + 1;
        continue;
      }
      if (token.text === ",") {
        ranges.push([segmentStart, index]);
        segmentStart = index + 1;
      }
      index++;
    }
    if (segmentStart < end) ranges.push([segmentStart, end]);
    return ranges;
  }

  function countTopLevelCommas(start: number, end: number): number {
    return splitTopLevel(start, end).length - 1;
  }

  /** Skips leading attribute lists, collecting their tokens; returns the index after them. */
  function skipAttributes(start: number, end: number, into: Token[][]): number {
    let index = start;
    while (index < end && tokens[index]?.kind === "punctuation" && tokens[index]?.text === "[") {
      const close = findClose(index, end);
      if (close === null) return index;
      into.push(tokens.slice(index + 1, close));
      index = close + 1;
    }
    return index;
  }

  /** Index of the closing `>` of the type argument list opening at `open`, or `null`. */
  function skipAngles(open: number, end: number): number | null {
    let depth = 0;
    for (let index = open; index < end; index++) {
      const token = tokens[index] as Token;
      if (token.text === "<") depth++;
      else if (token.text === ">") depth--;
      else if (token.text === ">>") depth -= 2;
      else if (token.text === ";" || token.text === "{" || token.text === "}") return null;
      if (depth <= 0) return depth === 0 ? index : null;
    }
    return null;
  }

  /**
   * Skips a type starting at `start` (`int`, `List<Foo?>`, `global::A.B[]`, `(int A, string B)`)
   * and returns the index after it, or `null` when no type starts there.
   */
  function skipType(start: number, end: number): number | null {
    let index = start;
    const first = tokens[index];
    if (first === undefined || index >= end) return null;
    if (first.text === "(") {
      const close = findClose(index, end);
      if (close === null) return null;
      index = close + 1;
    } else {
      if (first.kind !== "identifier") return null;
      index++;
      for (;;) {
        const token = tokens[index];
        if ((token?.text === "." || token?.text === "::") && tokens[index + 1]?.kind === "identifier") {
          index += 2;
          continue;
        }
        if (token?.text === "<") {
          const close = skipAngles(index, end);
          if (close === null) return null;
          index = close + 1;
          continue;
        }
        break;
      }
    }
    for (;;) {
      const token = tokens[index];
      if (token?.text === "?" || token?.text === "*") {
        index++;
        continue;
      }
      if (token?.text === "[") {
        const close = findClose(index, end);
        if (close === null) return null;
        // Only rank specifiers (`[]`, `[,]`) belong to a type.
        if (tokens.slice(index + 1, close).some((inner) => inner.text !== ",")) return index;
        index = close + 1;
        continue;
      }
      return index;
    }
  }
}

type TypeHead = { start: number; end: number; scope: Scope; modifiers: Set<string>; attributes: Token[][] };

/** A constant string literal; an interpolated string may depend on constants declared elsewhere. */
function isLiteral(token: Token | undefined): token is Token {
  return token?.kind === "string" && token.isInterpolated !== true;
}

type WireAttributes = { name: string | null; isIgnored: boolean; isRequired: boolean; error: string | null };

/**
 * `null!`, `default`, `default!` and `default(T)` only silence the compiler: a message without the
 * property still yields null or zero, so they are not a default value.
 */
function isRealDefault(initializer: Token[]): boolean {
  const meaningful = initializer.filter((token) => token.text !== "!");
  const first = meaningful[0];
  if (first === undefined) return false;
  if (first.kind === "identifier" && (first.text === "null" || first.text === "default")) {
    return !(meaningful.length === 1 || (first.text === "default" && meaningful[1]?.text === "("));
  }
  return true;
}

/** The string argument of an attribute named `name` in the lists, `undefined` when absent, `null` when not a literal. */
function readAttributeString(lists: Token[][], name: string): string | null | undefined {
  for (const list of lists) {
    for (const [position, token] of list.entries()) {
      if (token.kind !== "identifier" || list[position + 1]?.text === ".") continue;
      if (token.text.replace(/Attribute$/, "") !== name) continue;
      const argument = list[position + 2];
      const closing = list[position + 3];
      return list[position + 1]?.text === "(" && isLiteral(argument) && closing?.text === ")"
        ? argument.text
        : null;
    }
  }
  return undefined;
}

type IdentityAttributes = { urn: string | null; entityName: string | null; error: string | null };

/** MassTransit `[MessageUrn("...")]` and `[EntityName("...")]` on a type. */
function readIdentityAttributes(lists: Token[][]): IdentityAttributes {
  const urn = readAttributeString(lists, "MessageUrn");
  const entityName = readAttributeString(lists, "EntityName");
  const unreadable = [urn === null ? "MessageUrn" : "", entityName === null ? "EntityName" : ""].filter(
    Boolean,
  );
  return {
    urn: urn ?? null,
    entityName: entityName ?? null,
    error: unreadable.length > 0 ? `has a [${unreadable.join("], [")}] without a string literal` : null,
  };
}

/**
 * Reads `[JsonPropertyName("x")]` and `[JsonIgnore]` from attribute lists. On a positional
 * parameter only `property:`-targeted attributes reach the generated property.
 */
function readWireAttributes(lists: Token[][], isPositional: boolean): WireAttributes {
  const wire: WireAttributes = { name: null, isIgnored: false, isRequired: false, error: null };
  for (const list of lists) {
    const hasTarget = list[1]?.text === ":" && list[0]?.kind === "identifier";
    if (isPositional && !(hasTarget && list[0]?.text === "property")) continue;
    if (!isPositional && hasTarget && list[0]?.text !== "property") continue;
    for (const [position, token] of list.entries()) {
      if (token.kind !== "identifier") continue;
      const name = token.text.replace(/Attribute$/, "");
      if (list[position + 1]?.text === ".") continue;
      if (name === "JsonPropertyName") {
        const argument = list[position + 2];
        if (list[position + 1]?.text === "(" && isLiteral(argument) && list[position + 3]?.text === ")")
          wire.name = argument.text;
        else wire.error = "has a [JsonPropertyName] without a string literal";
      }
      if (name === "JsonRequired") wire.isRequired = true;
      if (name === "JsonIgnore") {
        // `Condition = WhenWritingNull` and similar still put the property on the wire.
        const rest = list.slice(position + 1);
        const hasCondition =
          rest[0]?.text === "(" && rest.some((candidate) => candidate.text === "Condition");
        const isAlways = rest.some((candidate) => candidate.text === "Always");
        if (!hasCondition || isAlways) wire.isIgnored = true;
      }
    }
  }
  return wire;
}

function joinText(tokens: Token[]): string {
  return tokens.map((token) => token.text).join("");
}

/** Normalized type text: trivia, `global::` and `System.` namespaces dropped, aliases and `Nullable<T>` unified. */
export function formatType(tokens: Token[]): string {
  const parts: string[] = [];
  let index = 0;
  while (index < tokens.length) {
    const token = tokens[index] as Token;
    if (token.kind === "identifier" && token.text === "global" && tokens[index + 1]?.text === "::") {
      index += 2;
      continue;
    }
    if (token.kind === "identifier") {
      // A qualified name: `System.Collections.Generic.List` becomes `List`, others stay qualified.
      const segments = [token.text];
      while (tokens[index + 1]?.text === "." && tokens[index + 2]?.kind === "identifier") {
        segments.push((tokens[index + 2] as Token).text);
        index += 2;
      }
      const last = segments.at(-1) as string;
      const isSystem = segments[0] === "System" && segments.length > 1;
      const name = isSystem || segments.length === 1 ? (SYSTEM_ALIASES[last] ?? last) : segments.join(".");
      if (parts.length > 0 && /[\w]$/.test(parts.at(-1) as string)) parts.push(" ");
      parts.push(name);
      index++;
      continue;
    }
    if (token.text === ">>") parts.push(">>");
    else parts.push(token.text === "," ? ", " : token.text);
    index++;
  }
  // Rank specifiers keep their commas tight: `int[,]`.
  let text = parts.join("").replace(/\[[, ]*\]/g, (rank) => rank.replaceAll(" ", ""));
  for (let previous = ""; previous !== text; ) {
    previous = text;
    text = text.replace(/\bNullable<([^<>]*)>/g, "$1?");
  }
  return text;
}

function getLineAt(text: string, offset: number): number {
  let line = 1;
  for (let index = 0; index < offset; index++) if (text.charCodeAt(index) === 10) line++;
  return line;
}
