export type SourceLanguage = "csharp" | "typescript";

export type Token = {
  /** `directive` is a C# conditional (`#if`, `#elif`, `#else`, `#endif`); other directives are dropped. */
  kind: "identifier" | "number" | "string" | "char" | "punctuation" | "directive";
  /** Identifier name, number literal, string or char content (unescaped), punctuation, or the directive name. */
  text: string;
  line: number;
  /** A C# interpolated string (`$"..."`): its text holds the holes, not a constant value. */
  isInterpolated?: boolean;
};

const IDENTIFIER_START = /[A-Za-z_$À-￿]/;
const IDENTIFIER_PART = /[A-Za-z0-9_$À-￿]/;
const NUMBER_PART = /[A-Za-z0-9_.]/;
const TWO_CHAR_PUNCTUATION = new Set(["<<", ">>", "=>", "::", "?."]);
const CONDITIONAL_DIRECTIVES = new Set(["if", "elif", "else", "endif"]);
const CHAR_ESCAPES: Record<string, string> = {
  n: "\n",
  t: "\t",
  r: "\r",
  "0": "\0",
  a: "\x07",
  b: "\b",
  f: "\f",
  v: "\v",
};
/** After these tokens a TypeScript `/` starts a regular expression literal, not a division. */
const REGEX_AFTER_PUNCTUATION = new Set([..."(,=:[!&|?{};+-*%<>~^", "=>"]);
const REGEX_AFTER_KEYWORDS = new Set([
  "return",
  "typeof",
  "case",
  "do",
  "else",
  "in",
  "of",
  "new",
  "delete",
  "void",
  "throw",
  "yield",
  "await",
]);

/**
 * Splits C# or TypeScript source into the tokens the enum parser needs. Comments and whitespace
 * are dropped; strings, chars and template literals become one token each, so braces and commas
 * inside them never reach the parser. The scanner is deliberately forgiving: it never fails.
 */
export function tokenize(
  text: string,
  language: SourceLanguage,
  /** Called with the `[start, end)` offsets of every comment, for callers that scan the raw text too. */
  onComment?: (start: number, end: number) => void,
): Token[] {
  const tokens: Token[] = [];
  let index = 0;
  let line = 1;
  let isLineStart = true;

  const advance = (count: number) => {
    for (let step = 0; step < count && index < text.length; step++) {
      if (text[index] === "\n") line++;
      index++;
    }
  };

  /** Reads a quoted literal starting at `index` (on the opening quote) and returns its content. */
  const readQuoted = (quote: string, allowEscapes: boolean): string => {
    advance(1);
    let content = "";
    while (index < text.length && text[index] !== quote) {
      if (allowEscapes && text[index] === "\\" && index + 1 < text.length) {
        content += text[index + 1];
        advance(2);
        continue;
      }
      if (!allowEscapes && text[index] === quote && text[index + 1] === quote) {
        content += quote;
        advance(2);
        continue;
      }
      // Only regular strings end at a line break; verbatim strings and template literals span lines.
      if (allowEscapes && quote !== "`" && text[index] === "\n") break;
      content += text[index];
      advance(1);
    }
    advance(1);
    return content;
  };

  while (index < text.length) {
    const char = text[index] as string;
    const next = text[index + 1];
    const startLine = line;

    if (char === "\n") {
      isLineStart = true;
      advance(1);
      continue;
    }
    if (/\s/.test(char)) {
      advance(1);
      continue;
    }
    const wasLineStart = isLineStart;
    isLineStart = false;
    if (language === "csharp" && char === "#" && wasLineStart) {
      // A preprocessor line such as `#region Legacy` or `#if DEBUG` runs to the end of the line.
      const name = /^#\s*(\w*)/.exec(text.slice(index, index + 40))?.[1] ?? "";
      while (index < text.length && text[index] !== "\n") advance(1);
      if (CONDITIONAL_DIRECTIVES.has(name)) tokens.push({ kind: "directive", text: name, line: startLine });
    } else if (char === "/" && next === "/") {
      const start = index;
      while (index < text.length && text[index] !== "\n") advance(1);
      onComment?.(start, index);
    } else if (char === "/" && next === "*") {
      const start = index;
      const end = text.indexOf("*/", index + 2);
      advance(end === -1 ? text.length - index : end + 2 - index);
      onComment?.(start, index);
    } else if (language === "csharp" && /^[$@]*"/.test(text.slice(index, index + 8))) {
      const isInterpolated = /^@?\$/.test(text.slice(index, index + 3));
      tokens.push({
        kind: "string",
        text: readCSharpString(),
        line: startLine,
        ...(isInterpolated ? { isInterpolated } : {}),
      });
    } else if (language === "csharp" && char === "'") {
      tokens.push({ kind: "char", text: readCSharpChar(), line: startLine });
    } else if (char === '"' || char === "'" || (language === "typescript" && char === "`")) {
      tokens.push({ kind: "string", text: readQuoted(char, true), line: startLine });
    } else if (language === "typescript" && char === "/" && isRegexStart(tokens.at(-1))) {
      skipRegex();
    } else if (language === "csharp" && char === "@" && next !== undefined && IDENTIFIER_START.test(next)) {
      // `@event` is the identifier `event`.
      advance(1);
      tokens.push({ kind: "identifier", text: readWhile(IDENTIFIER_PART), line: startLine });
    } else if (IDENTIFIER_START.test(char)) {
      tokens.push({ kind: "identifier", text: readWhile(IDENTIFIER_PART), line: startLine });
    } else if (/[0-9]/.test(char) || (char === "." && next !== undefined && /[0-9]/.test(next))) {
      tokens.push({ kind: "number", text: readWhile(NUMBER_PART), line: startLine });
    } else {
      const pair = text.slice(index, index + 2);
      const punctuation = TWO_CHAR_PUNCTUATION.has(pair) ? pair : char;
      advance(punctuation.length);
      tokens.push({ kind: "punctuation", text: punctuation, line: startLine });
    }
  }
  return tokens;

  function isRegexStart(previous: Token | undefined): boolean {
    if (previous === undefined) return true;
    if (previous.kind === "punctuation") return REGEX_AFTER_PUNCTUATION.has(previous.text);
    return previous.kind === "identifier" && REGEX_AFTER_KEYWORDS.has(previous.text);
  }

  /** Regular, verbatim (`@`), interpolated (`$`) and raw (`"""`, `$$"""`) C# strings. */
  function readCSharpString(): string {
    let isVerbatim = false;
    let isInterpolated = false;
    while (text[index] === "@" || text[index] === "$") {
      if (text[index] === "@") isVerbatim = true;
      else isInterpolated = true;
      advance(1);
    }
    let quotes = 0;
    while (text[index + quotes] === '"') quotes++;
    if (quotes >= 3) {
      // Raw string literal: as many quotes close it as opened it.
      const delimiter = '"'.repeat(quotes);
      const end = text.indexOf(delimiter, index + quotes);
      const content = text.slice(index + quotes, end === -1 ? text.length : end);
      advance(end === -1 ? text.length - index : end + quotes - index);
      return content;
    }
    return isInterpolated ? readInterpolated(isVerbatim) : readQuoted('"', !isVerbatim);
  }

  /**
   * An interpolated string whose holes may hold strings, chars and braces of their own:
   * `$"{(a ? "x" : "}")}"`. `{{` and `}}` are literal braces outside holes.
   */
  function readInterpolated(isVerbatim: boolean): string {
    advance(1);
    const start = index;
    let depth = 0;
    while (index < text.length) {
      const current = text[index] as string;
      const following = text[index + 1];
      if (depth > 0) {
        if (
          current === '"' ||
          ((current === "@" || current === "$") && /^[$@]*"/.test(text.slice(index, index + 4)))
        ) {
          readCSharpString();
          continue;
        }
        if (current === "'") {
          readCSharpChar();
          continue;
        }
        if (current === "{") depth++;
        if (current === "}") depth--;
        advance(1);
        continue;
      }
      if (current === '"') {
        if (isVerbatim && following === '"') {
          advance(2);
          continue;
        }
        break;
      }
      if (!isVerbatim && current === "\\") {
        advance(2);
        continue;
      }
      if (!isVerbatim && current === "\n") break;
      if ((current === "{" || current === "}") && following === current) {
        advance(2);
        continue;
      }
      if (current === "{") depth = 1;
      advance(1);
    }
    const content = text.slice(start, index);
    if (text[index] === '"') advance(1);
    return content;
  }

  function readCSharpChar(): string {
    advance(1);
    let content = "";
    while (index < text.length && text[index] !== "'" && text[index] !== "\n") {
      if (text[index] === "\\" && index + 1 < text.length) {
        const escaped = text[index + 1] as string;
        if (escaped === "u" || escaped === "x") {
          const hex = /^[0-9a-fA-F]{1,4}/.exec(text.slice(index + 2, index + 6))?.[0] ?? "";
          content += String.fromCharCode(Number.parseInt(hex || "0", 16));
          advance(2 + hex.length);
          continue;
        }
        content += CHAR_ESCAPES[escaped] ?? escaped;
        advance(2);
        continue;
      }
      content += text[index];
      advance(1);
    }
    if (text[index] === "'") advance(1);
    return content;
  }

  /** Skips `/pattern/flags`; a character class may hold an unescaped `/`. */
  function skipRegex(): void {
    advance(1);
    let isInClass = false;
    while (index < text.length && text[index] !== "\n") {
      const current = text[index];
      if (current === "\\") {
        advance(2);
        continue;
      }
      if (current === "[") isInClass = true;
      if (current === "]") isInClass = false;
      advance(1);
      if (current === "/" && !isInClass) break;
    }
    readWhile(/[A-Za-z]/);
  }

  function readWhile(pattern: RegExp): string {
    const start = index;
    while (index < text.length && pattern.test(text[index] as string)) advance(1);
    return text.slice(start, index);
  }
}
