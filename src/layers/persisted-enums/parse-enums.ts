import { err, ok, type Result } from "../../result.js";
import { type SourceLanguage, type Token, tokenize } from "./tokenize.js";

export type EnumMember = {
  name: string;
  line: number;
  /** The initializer as written (tokens joined by spaces), or `null` when the value is implicit. */
  valueText: string | null;
  /** The numeric value, or `null` when it is a string or cannot be computed without a compiler. */
  value: bigint | null;
  /** The string value of a TypeScript string member. */
  stringValue: string | null;
};

export type EnumDeclaration = { name: string; line: number; members: EnumMember[] };

/** An enum the parser found but could not read; the other enums of the file are still returned. */
export type EnumFailure = { name: string; line: number; error: string };

export type ParsedEnums = { declarations: EnumDeclaration[]; failures: EnumFailure[] };

type RawMember = { name: string; line: number; initializer: Token[] };

const TS_MODIFIERS = new Set(["const", "declare", "export"]);

/** Finds every enum declared in a C# or TypeScript file and evaluates its member values. */
export function parseEnums(text: string, language: SourceLanguage): ParsedEnums {
  const tokens = tokenize(text, language);
  const declarations: EnumDeclaration[] = [];
  const failures: EnumFailure[] = [];

  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index] as Token;
    if (token.kind !== "identifier" || token.text !== "enum") continue;
    const previous = tokens[index - 1];
    if (previous?.kind === "punctuation" && (previous.text === "." || previous.text === "?.")) continue;
    const nameToken = tokens[index + 1];
    if (nameToken?.kind !== "identifier" || TS_MODIFIERS.has(nameToken.text)) continue;
    const open = findBodyStart(tokens, index + 2, language);
    if (open === null) continue;
    const failAt = (error: string) =>
      failures.push({
        name: nameToken.text,
        line: token.line,
        error: `enum "${nameToken.text}" at line ${token.line} ${error}`,
      });
    const close = findClosingBrace(tokens, open);
    if (close === null) {
      // Nothing after an unclosed body can be trusted.
      failAt("has no closing brace");
      break;
    }
    const body = tokens.slice(open + 1, close);
    const directive = body.find((bodyToken) => bodyToken.kind === "directive");
    index = close;
    if (directive !== undefined) {
      failAt(`has a #${directive.text} at line ${directive.line}; conditional members cannot be compared`);
      continue;
    }
    const rawMembers = splitMembers(body, language);
    if (!rawMembers.ok) {
      failAt(rawMembers.error);
      continue;
    }
    declarations.push({
      name: nameToken.text,
      line: token.line,
      members: evaluateMembers({ enumName: nameToken.text, rawMembers: rawMembers.value, language }),
    });
  }
  return { declarations, failures };
}

/** Index of the `{` that opens the body, after an optional C# base type (`: byte`). */
function findBodyStart(tokens: Token[], start: number, language: SourceLanguage): number | null {
  let index = start;
  if (language === "csharp" && tokens[index]?.text === ":") {
    index++;
    while (tokens[index]?.kind === "identifier" || tokens[index]?.text === ".") index++;
  }
  return tokens[index]?.kind === "punctuation" && tokens[index]?.text === "{" ? index : null;
}

function findClosingBrace(tokens: Token[], open: number): number | null {
  let depth = 0;
  for (let index = open; index < tokens.length; index++) {
    const token = tokens[index] as Token;
    if (token.kind !== "punctuation") continue;
    if (token.text === "{") depth++;
    if (token.text === "}") {
      depth--;
      if (depth === 0) return index;
    }
  }
  return null;
}

function splitMembers(body: Token[], language: SourceLanguage): Result<RawMember[]> {
  const segments: Token[][] = [[]];
  let depth = 0;
  for (const token of body) {
    if (token.kind === "punctuation") {
      if ("([{".includes(token.text)) depth++;
      if (")]}".includes(token.text)) depth--;
      if (token.text === "," && depth === 0) {
        segments.push([]);
        continue;
      }
    }
    segments.at(-1)?.push(token);
  }
  const members: RawMember[] = [];
  for (const [position, segment] of segments.entries()) {
    const tokens = language === "csharp" ? skipAttributes(segment) : segment;
    const nameToken = tokens[0];
    // Only the segment after a trailing comma may be empty.
    if (nameToken === undefined && position === segments.length - 1) continue;
    const hasInitializer = tokens[1]?.text === "=";
    const isReadable =
      nameToken !== undefined &&
      (nameToken.kind === "identifier" || nameToken.kind === "string") &&
      (tokens.length === 1 || (hasInitializer && tokens.length > 2));
    if (!isReadable) {
      const line = nameToken?.line ?? segment[0]?.line ?? body[0]?.line;
      return err(`has an unreadable member ${position + 1}${line === undefined ? "" : ` at line ${line}`}`);
    }
    members.push({
      name: nameToken.text,
      line: nameToken.line,
      initializer: hasInitializer ? tokens.slice(2) : [],
    });
  }
  return ok(members);
}

/** Drops leading C# attribute lists such as `[Display(Name = "x")]`. */
function skipAttributes(tokens: Token[]): Token[] {
  let index = 0;
  while (tokens[index]?.kind === "punctuation" && tokens[index]?.text === "[") {
    let depth = 0;
    for (; index < tokens.length; index++) {
      const token = tokens[index] as Token;
      if (token.kind !== "punctuation") continue;
      if (token.text === "[") depth++;
      if (token.text === "]") {
        depth--;
        if (depth === 0) {
          index++;
          break;
        }
      }
    }
  }
  return tokens.slice(index);
}

type Value = { kind: "number"; value: bigint } | { kind: "string"; value: string } | { kind: "unknown" };

const UNKNOWN: Value = { kind: "unknown" };

type EvaluateMembersOptions = { enumName: string; rawMembers: RawMember[]; language: SourceLanguage };

function evaluateMembers({ enumName, rawMembers, language }: EvaluateMembersOptions): EnumMember[] {
  const byName = new Map(rawMembers.map((member, position) => [member.name, position]));
  const values = new Map<number, Value>();
  const inProgress = new Set<number>();

  const getValueAt = (position: number): Value => {
    const known = values.get(position);
    if (known !== undefined) return known;
    if (inProgress.has(position)) return UNKNOWN;
    inProgress.add(position);
    const member = rawMembers[position] as RawMember;
    let value: Value;
    if (member.initializer.length === 0) {
      const previous = position === 0 ? { kind: "number" as const, value: -1n } : getValueAt(position - 1);
      value = previous.kind === "number" ? { kind: "number", value: previous.value + 1n } : UNKNOWN;
    } else {
      value = evaluateExpression(
        member.initializer,
        (name) => {
          const target = byName.get(name);
          return target === undefined ? UNKNOWN : getValueAt(target);
        },
        { enumName, language },
      );
    }
    inProgress.delete(position);
    values.set(position, value);
    return value;
  };

  return rawMembers.map((member, position) => {
    const value = getValueAt(position);
    return {
      name: member.name,
      line: member.line,
      valueText: member.initializer.length === 0 ? null : member.initializer.map(formatToken).join(" "),
      value: value.kind === "number" ? value.value : null,
      stringValue: value.kind === "string" ? value.value : null,
    };
  });
}

function formatToken(token: Token): string {
  if (token.kind === "string") return JSON.stringify(token.text);
  return token.kind === "char" ? `'${token.text}'` : token.text;
}

const BINARY_PRECEDENCE: Record<string, number> = {
  "|": 1,
  "^": 2,
  "&": 3,
  "<<": 4,
  ">>": 4,
  "+": 5,
  "-": 5,
  "*": 6,
  "/": 6,
  "%": 6,
};

/**
 * Evaluates a constant initializer with BigInt arithmetic. Anything outside literals, unary and
 * binary operators, parentheses and references to members of the same enum is unknown.
 */
type ExpressionContext = { enumName: string; language: SourceLanguage };

function evaluateExpression(
  tokens: Token[],
  resolve: (name: string) => Value,
  { enumName, language }: ExpressionContext,
): Value {
  let index = 0;

  const parsePrimary = (): Value => {
    const token = tokens[index];
    if (token === undefined) return UNKNOWN;
    index++;
    if (token.kind === "number") return parseNumber(token.text);
    // A C# enum stores numbers only: a char is its UTF-16 code unit, a string is not a constant value.
    if (token.kind === "char")
      return token.text.length === 1 ? { kind: "number", value: BigInt(token.text.charCodeAt(0)) } : UNKNOWN;
    if (token.kind === "string")
      return language === "typescript" ? { kind: "string", value: token.text } : UNKNOWN;
    if (token.kind === "identifier") {
      let name = token.text;
      if (name === enumName && tokens[index]?.text === "." && tokens[index + 1]?.kind === "identifier") {
        name = (tokens[index + 1] as Token).text;
        index += 2;
      }
      if (tokens[index]?.text === "." || tokens[index]?.text === "(") return UNKNOWN;
      return resolve(name);
    }
    if (token.text === "(") {
      const inner = parseBinary(0);
      if (tokens[index]?.text !== ")") return UNKNOWN;
      index++;
      return inner;
    }
    if (token.text === "-" || token.text === "+" || token.text === "~") {
      const operand = parsePrimary();
      if (operand.kind !== "number") return UNKNOWN;
      if (token.text === "-") return { kind: "number", value: -operand.value };
      if (token.text === "~") return { kind: "number", value: ~operand.value };
      return operand;
    }
    return UNKNOWN;
  };

  const parseBinary = (minPrecedence: number): Value => {
    let left = parsePrimary();
    for (;;) {
      const operator = tokens[index];
      const precedence = operator?.kind === "punctuation" ? BINARY_PRECEDENCE[operator.text] : undefined;
      if (operator === undefined || precedence === undefined || precedence <= minPrecedence) return left;
      index++;
      const right = parseBinary(precedence);
      left = applyBinary(operator.text, left, right);
    }
  };

  const result = parseBinary(0);
  return index === tokens.length ? result : UNKNOWN;
}

function applyBinary(operator: string, left: Value, right: Value): Value {
  if (left.kind !== "number" || right.kind !== "number") return UNKNOWN;
  const a = left.value;
  const b = right.value;
  switch (operator) {
    case "|":
      return { kind: "number", value: a | b };
    case "^":
      return { kind: "number", value: a ^ b };
    case "&":
      return { kind: "number", value: a & b };
    case "<<":
      return b < 0n || b > MAX_SHIFT ? UNKNOWN : checkWidth(a << b);
    case ">>":
      return b < 0n || b > MAX_SHIFT ? UNKNOWN : { kind: "number", value: a >> b };
    case "+":
      return checkWidth(a + b);
    case "-":
      return checkWidth(a - b);
    case "*":
      return checkWidth(a * b);
    case "/":
      return b === 0n ? UNKNOWN : { kind: "number", value: a / b };
    case "%":
      return b === 0n ? UNKNOWN : { kind: "number", value: a % b };
    default:
      return UNKNOWN;
  }
}

const MAX_SHIFT = 64n;
const MAX_MAGNITUDE = 2n ** 64n;

/** Values wider than 64 bits fit no enum type; they are unknown rather than a huge BigInt. */
function checkWidth(value: bigint): Value {
  return value >= MAX_MAGNITUDE || value <= -MAX_MAGNITUDE ? UNKNOWN : { kind: "number", value };
}

/** Integer literals of C# and TypeScript: decimal, hex, binary, octal (`0o`), `_` separators, C# suffixes. */
function parseNumber(literal: string): Value {
  const cleaned = literal.replaceAll("_", "").replace(/(?:[uU][lL]?|[lL][uU]?)$/, "");
  if (/^(?:0[xX][0-9a-fA-F]+|0[bB][01]+|0[oO][0-7]+|[0-9]+)$/.test(cleaned)) {
    return { kind: "number", value: BigInt(cleaned) };
  }
  return UNKNOWN;
}
