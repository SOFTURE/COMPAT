export type SourceLanguage = "csharp" | "typescript";

export type Token = {
  /** `directive` is a C# conditional (`#if`, `#elif`, `#else`, `#endif`); other directives are dropped. */
  kind: "identifier" | "number" | "string" | "punctuation" | "directive";
  /** Identifier name, number literal, string content (unescaped), punctuation, or the directive name. */
  text: string;
  line: number;
};

const IDENTIFIER_START = /[A-Za-z_$À-￿]/;
const IDENTIFIER_PART = /[A-Za-z0-9_$À-￿]/;
const NUMBER_PART = /[A-Za-z0-9_.]/;
const TWO_CHAR_PUNCTUATION = new Set(["<<", ">>", "=>", "::", "?."]);
const CONDITIONAL_DIRECTIVES = new Set(["if", "elif", "else", "endif"]);

/**
 * Splits C# or TypeScript source into the tokens the enum parser needs. Comments and whitespace
 * are dropped; strings, chars and template literals become one token each, so braces and commas
 * inside them never reach the parser. The scanner is deliberately forgiving: it never fails.
 */
export function tokenize(text: string, language: SourceLanguage): Token[] {
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
      if (quote !== "`" && text[index] === "\n") break;
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
      while (index < text.length && text[index] !== "\n") advance(1);
    } else if (char === "/" && next === "*") {
      const end = text.indexOf("*/", index + 2);
      advance(end === -1 ? text.length - index : end + 2 - index);
    } else if (language === "csharp" && text.startsWith('"""', index)) {
      // Raw string literal: as many quotes close it as opened it.
      let quotes = 0;
      while (text[index + quotes] === '"') quotes++;
      const delimiter = '"'.repeat(quotes);
      const end = text.indexOf(delimiter, index + quotes);
      const content = text.slice(index + quotes, end === -1 ? text.length : end);
      advance(end === -1 ? text.length - index : end + quotes - index);
      tokens.push({ kind: "string", text: content, line: startLine });
    } else if (language === "csharp" && (char === "@" || char === "$") && (next === '"' || next === "@")) {
      // Verbatim (`@"..."`) and interpolated verbatim (`$@"..."`, `@$"..."`) strings.
      while (text[index] === "@" || text[index] === "$") advance(1);
      tokens.push({ kind: "string", text: readQuoted('"', false), line: startLine });
    } else if (language === "csharp" && char === "$" && next === '"') {
      advance(1);
      tokens.push({ kind: "string", text: readQuoted('"', true), line: startLine });
    } else if (char === '"' || char === "'" || (language === "typescript" && char === "`")) {
      tokens.push({ kind: "string", text: readQuoted(char, true), line: startLine });
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

  function readWhile(pattern: RegExp): string {
    const start = index;
    while (index < text.length && pattern.test(text[index] as string)) advance(1);
    return text.slice(start, index);
  }
}
