import { type Token, tokenize } from "../persisted-enums/tokenize.js";

/** An enum that reaches clients as a plain string, and the property names (lower case) that carry it. */
export type BranchTarget = { enumName: string; properties: string[] };

const EQUALITY_START = new Set(["=", "!"]);
const CHAIN_LINK = new Set([".", "?."]);
const RAW_BRANCH = /\bswitch\b|\bcase\b|[=!]==?|\bRecord\s*</;
const WORD_EDGE = "[A-Za-z0-9_$]";

function escapeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Matches any of the words as a whole identifier, `$` included. */
function createWordPattern(words: string[], flags: string): RegExp {
  const alternatives = words.map(escapeRegex).join("|");
  return new RegExp(`(?<!${WORD_EDGE})(?:${alternatives})(?!${WORD_EDGE})`, flags);
}

function isText(token: Token | undefined, text: string): boolean {
  return token?.kind === "punctuation" && token.text === text;
}

/** The index of the token closing the bracket opened at `open`, or the last index when unbalanced. */
function findClose(tokens: Token[], open: number, opening: string, closing: string): number {
  let depth = 0;
  for (let index = open; index < tokens.length; index++) {
    if (isText(tokens[index], opening)) depth++;
    else if (isText(tokens[index], closing) && --depth === 0) return index;
  }
  return tokens.length - 1;
}

/**
 * Lines of a TypeScript client source that branch on an exposed enum: a `switch` over the property
 * or the enum, an equality with an operand chain ending in the property or naming the enum,
 * `case Enum.X`, `Record<Enum, ...>`, `[key in Enum]` or an index access `[x.property]`.
 *
 * A raw-text safety net adds every line (comments excluded) that holds a branch-looking construct
 * and the property or enum word where the tokenizer saw no such identifier, so a scanner miss
 * reads as a branch, never as "does not branch".
 */
export function findEnumBranches(text: string, target: BranchTarget): number[] {
  const comments: [number, number][] = [];
  const tokens = tokenize(text, "typescript", (start, end) => comments.push([start, end]));
  const properties = new Set(target.properties.map((property) => property.toLowerCase()));
  const isProperty = (token: Token | undefined) =>
    token?.kind === "identifier" && properties.has(token.text.toLowerCase());
  const isEnum = (token: Token | undefined) => token?.kind === "identifier" && token.text === target.enumName;
  const isWatched = (token: Token | undefined) => isProperty(token) || isEnum(token);
  const lines = new Set<number>();

  /** Tokens of the `a?.b.c` chain that ends at `end` (inclusive), walking backwards. */
  const chainBefore = (end: number): Token[] => {
    const chain: Token[] = [];
    let index = end;
    while (tokens[index]?.kind === "identifier") {
      chain.push(tokens[index] as Token);
      if (!CHAIN_LINK.has(tokens[index - 1]?.text ?? "") || tokens[index - 1]?.kind !== "punctuation") break;
      index -= 2;
    }
    return chain.reverse();
  };
  /** Tokens of the chain that starts at `start`, walking forwards. */
  const chainAfter = (start: number): Token[] => {
    const chain: Token[] = [];
    let index = start;
    while (tokens[index]?.kind === "identifier") {
      chain.push(tokens[index] as Token);
      if (!CHAIN_LINK.has(tokens[index + 1]?.text ?? "") || tokens[index + 1]?.kind !== "punctuation") break;
      index += 2;
    }
    return chain;
  };
  const isBranchOperand = (chain: Token[]) => isProperty(chain.at(-1)) || chain.some(isEnum);

  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index] as Token;
    const next = tokens[index + 1];
    if (token.kind === "identifier" && token.text === "switch" && isText(next, "(")) {
      const close = findClose(tokens, index + 1, "(", ")");
      if (tokens.slice(index + 2, close).some(isWatched)) lines.add(token.line);
    } else if (token.kind === "identifier" && token.text === "case" && isEnum(next)) {
      lines.add(token.line);
    } else if (token.kind === "identifier" && token.text === "in" && isEnum(next)) {
      lines.add(token.line);
    } else if (token.kind === "identifier" && token.text === "Record" && isText(next, "<")) {
      const close = findClose(tokens, index + 1, "<", ">");
      const firstArgument: Token[] = [];
      let depth = 0;
      for (const item of tokens.slice(index + 2, close)) {
        if (item.kind === "punctuation" && "<([{".includes(item.text)) depth++;
        if (item.kind === "punctuation" && ">)]}".includes(item.text)) depth--;
        if (depth === 0 && isText(item, ",")) break;
        firstArgument.push(item);
      }
      const isKeyedByEnum = firstArgument.some(
        (item) => isWatched(item) || (item.kind === "string" && properties.has(item.text.toLowerCase())),
      );
      if (isKeyedByEnum) lines.add(token.line);
    } else if (isText(token, "[")) {
      const close = findClose(tokens, index, "[", "]");
      const inside = chainAfter(index + 1);
      if (inside.length > 0 && index + inside.length * 2 === close && isProperty(inside.at(-1))) {
        lines.add(token.line);
      }
    } else if (
      token.kind === "punctuation" &&
      EQUALITY_START.has(token.text) &&
      isText(next, "=") &&
      !(token.text === "=" && ["=", "!", "<", ">"].includes(tokens[index - 1]?.text ?? ""))
    ) {
      const end = isText(tokens[index + 2], "=") ? index + 2 : index + 1;
      if (isBranchOperand(chainBefore(index - 1)) || isBranchOperand(chainAfter(end + 1))) {
        lines.add(token.line);
      }
      index = end;
    }
  }

  for (const line of findUnparsedLines(text, { tokens, comments, target })) lines.add(line);
  return [...lines].sort((a, b) => a - b);
}

type RawScan = { tokens: Token[]; comments: [number, number][]; target: BranchTarget };

/**
 * Branch-looking lines where the property or enum word occurs more often in the text than the
 * tokenizer read it as an identifier: inside a template literal, or after a literal it lost.
 */
function findUnparsedLines(text: string, { tokens, comments, target }: RawScan): number[] {
  const parts: string[] = [];
  let offset = 0;
  for (const [start, end] of comments) {
    parts.push(text.slice(offset, start), text.slice(start, end).replace(/[^\n]/g, " "));
    offset = end;
  }
  parts.push(text.slice(offset));
  const code = parts.join("");
  const words = createWordPattern([...target.properties, target.enumName], "gi");
  const property = createWordPattern(target.properties, "i").source;
  const branch = new RegExp(`${RAW_BRANCH.source}|\\[[^\\]\\n]*\\.\\s*${property}\\s*\\]`, "i");
  const watched = new Set([...target.properties, target.enumName].map((word) => word.toLowerCase()));
  const readAsCode = new Map<number, number>();
  for (const token of tokens) {
    if (token.kind === "identifier" && watched.has(token.text.toLowerCase())) {
      readAsCode.set(token.line, (readAsCode.get(token.line) ?? 0) + 1);
    }
  }
  const lines: number[] = [];
  code.split("\n").forEach((line, position) => {
    const number = position + 1;
    const occurrences = line.match(words)?.length ?? 0;
    if (occurrences > (readAsCode.get(number) ?? 0) && branch.test(line)) lines.push(number);
  });
  return lines;
}
