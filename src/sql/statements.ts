/**
 * A dialect-aware SQL scanner. It knows where strings, quoted identifiers, comments and Postgres
 * dollar quotes start and end, which is all that is needed to split a script into statements
 * without parsing it. Shared by the `sql-migrations` and `seed` layers.
 */

export type SqlDialect = "postgres" | "sqlserver";

export const SQL_DIALECTS = ["postgres", "sqlserver"] as const satisfies readonly SqlDialect[];

export type SqlStatement = {
  /** Statement text with comments replaced by spaces, trimmed, without the terminating `;`. */
  sql: string;
  /** 1-based line of the statement's first character in the scanned text. */
  line: number;
  /** Offset of the statement's first character in the scanned text. */
  offset: number;
};

type RangeKind = "code" | "string" | "identifier" | "comment" | "dollar";

type Range = { kind: RangeKind; start: number; end: number };

const IDENTIFIER_CHAR = /[A-Za-z0-9_$]/;
const DOLLAR_TAG = /\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$/y;
const GO_LINE = /^[ \t]*go(?:[ \t]+\d+)?[ \t]*\r?$/gim;
const WHOLE_BATCH_STATEMENT =
  /^(?:CREATE(?:\s+OR\s+ALTER)?|ALTER)\s+(?:PROC|PROCEDURE|FUNCTION|TRIGGER|VIEW)\b/i;

function scanLineComment(text: string, start: number): number {
  const end = text.indexOf("\n", start);
  return end === -1 ? text.length : end;
}

function scanBlockComment(text: string, start: number): number {
  let depth = 0;
  let index = start;
  while (index < text.length) {
    if (text.startsWith("/*", index)) {
      depth += 1;
      index += 2;
    } else if (text.startsWith("*/", index)) {
      depth -= 1;
      index += 2;
      if (depth === 0) return index;
    } else {
      index += 1;
    }
  }
  return text.length;
}

function scanQuoted(text: string, start: number, close: string, hasBackslashEscapes = false): number {
  let index = start + 1;
  while (index < text.length) {
    const char = text[index];
    if (hasBackslashEscapes && char === "\\") {
      index += 2;
      continue;
    }
    if (char === close) {
      if (text[index + 1] === close) {
        index += 2;
        continue;
      }
      return index + 1;
    }
    index += 1;
  }
  return text.length;
}

function isEscapeStringPrefix(text: string, quoteIndex: number): boolean {
  const prefix = text[quoteIndex - 1];
  if (prefix !== "E" && prefix !== "e") return false;
  const beforePrefix = text[quoteIndex - 2];
  return beforePrefix === undefined || !IDENTIFIER_CHAR.test(beforePrefix);
}

function scanDollarQuote(text: string, start: number): number | null {
  const before = text[start - 1];
  if (before !== undefined && IDENTIFIER_CHAR.test(before)) return null;
  DOLLAR_TAG.lastIndex = start;
  const tag = DOLLAR_TAG.exec(text)?.[0];
  if (tag === undefined) return null;
  const close = text.indexOf(tag, start + tag.length);
  return close === -1 ? text.length : close + tag.length;
}

/** Splits `text` into contiguous ranges of code, strings, quoted identifiers, comments and dollar quotes. */
function tokenize(text: string, dialect: SqlDialect): Range[] {
  const ranges: Range[] = [];
  let codeStart = 0;
  let index = 0;
  const push = (kind: RangeKind, start: number, end: number): void => {
    if (codeStart < start) ranges.push({ kind: "code", start: codeStart, end: start });
    ranges.push({ kind, start, end });
    codeStart = end;
    index = end;
  };
  while (index < text.length) {
    const char = text[index];
    if (char === "-" && text[index + 1] === "-") {
      push("comment", index, scanLineComment(text, index));
    } else if (char === "/" && text[index + 1] === "*") {
      push("comment", index, scanBlockComment(text, index));
    } else if (char === "'") {
      const hasBackslashEscapes = dialect === "postgres" && isEscapeStringPrefix(text, index);
      push("string", index, scanQuoted(text, index, "'", hasBackslashEscapes));
    } else if (char === '"') {
      push("identifier", index, scanQuoted(text, index, '"'));
    } else if (char === "[" && dialect === "sqlserver") {
      push("identifier", index, scanQuoted(text, index, "]"));
    } else if (char === "$" && dialect === "postgres") {
      const end = scanDollarQuote(text, index);
      if (end === null) index += 1;
      else push("dollar", index, end);
    } else {
      index += 1;
    }
  }
  if (codeStart < text.length) ranges.push({ kind: "code", start: codeStart, end: text.length });
  return ranges;
}

/** The text with every comment replaced by spaces; newlines are kept, so offsets and lines stay true. */
export function maskComments(text: string, dialect: SqlDialect): string {
  let masked = "";
  for (const range of tokenize(text, dialect)) {
    const part = text.slice(range.start, range.end);
    masked += range.kind === "comment" ? part.replace(/[^\n]/g, " ") : part;
  }
  return masked;
}

function createLineIndex(text: string): (offset: number) => number {
  const lineStarts = [0];
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] === "\n") lineStarts.push(index + 1);
  }
  return (offset) => {
    let low = 0;
    let high = lineStarts.length - 1;
    while (low < high) {
      const middle = Math.ceil((low + high) / 2);
      if ((lineStarts[middle] as number) <= offset) low = middle;
      else high = middle - 1;
    }
    return low + 1;
  };
}

/** 1-based line number of `offset` in `text`. */
export function getLineAt(text: string, offset: number): number {
  return createLineIndex(text)(offset);
}

/** Sorted offsets of `char` where it is code. */
function getCodeOffsets(text: string, ranges: Range[], char: string): number[] {
  const offsets: number[] = [];
  for (const range of ranges) {
    if (range.kind !== "code") continue;
    for (let index = range.start; index < range.end; index += 1) {
      if (text[index] === char) offsets.push(index);
    }
  }
  return offsets;
}

function isInCode(ranges: Range[], offset: number): boolean {
  return ranges.some((range) => range.kind === "code" && range.start <= offset && offset < range.end);
}

/** `[start, end)` spans between `GO` lines (SQL Server) or the whole text (Postgres). */
function getBatches(masked: string, ranges: Range[], dialect: SqlDialect): [number, number][] {
  if (dialect !== "sqlserver") return [[0, masked.length]];
  const batches: [number, number][] = [];
  let start = 0;
  for (const match of masked.matchAll(GO_LINE)) {
    const keyword = match.index + match[0].search(/\S/);
    if (!isInCode(ranges, keyword)) continue;
    batches.push([start, match.index]);
    start = match.index + match[0].length;
  }
  batches.push([start, masked.length]);
  return batches;
}

/**
 * Splits a script into statements. `;` ends a statement outside strings, quoted identifiers,
 * comments and dollar quotes. In `sqlserver`, a line holding only `GO` also ends one, and a batch
 * that defines a procedure, function, trigger or view stays a single statement.
 */
export function splitStatements(text: string, dialect: SqlDialect): SqlStatement[] {
  const masked = maskComments(text, dialect);
  const ranges = tokenize(masked, dialect);
  const lineAt = createLineIndex(text);
  const statements: SqlStatement[] = [];
  const emit = (start: number, end: number): void => {
    const raw = masked.slice(start, end);
    const leading = raw.length - raw.trimStart().length;
    const sql = raw.trim().replace(/;$/, "").trimEnd();
    if (sql === "") return;
    statements.push({ sql, line: lineAt(start + leading), offset: start + leading });
  };
  const terminators = getCodeOffsets(masked, ranges, ";");
  let next = 0;
  for (const [batchStart, batchEnd] of getBatches(masked, ranges, dialect)) {
    while (next < terminators.length && (terminators[next] as number) < batchStart) next += 1;
    if (WHOLE_BATCH_STATEMENT.test(masked.slice(batchStart, batchEnd).trimStart())) {
      emit(batchStart, batchEnd);
      continue;
    }
    let start = batchStart;
    while (next < terminators.length && (terminators[next] as number) < batchEnd) {
      const index = terminators[next] as number;
      emit(start, index);
      start = index + 1;
      next += 1;
    }
    emit(start, batchEnd);
  }
  return statements;
}

/**
 * Splits `text` at `separator` where it is outside parentheses, strings, quoted identifiers,
 * comments and dollar quotes. Used for column lists, `VALUES` tuples and `ALTER TABLE` actions.
 */
export function splitTopLevel(text: string, dialect: SqlDialect, separator = ","): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (const range of tokenize(text, dialect)) {
    if (range.kind !== "code") continue;
    for (let index = range.start; index < range.end; index += 1) {
      const char = text[index];
      if (char === "(") depth += 1;
      else if (char === ")") depth -= 1;
      else if (char === separator && depth === 0) {
        parts.push(text.slice(start, index).trim());
        start = index + 1;
      }
    }
  }
  parts.push(text.slice(start).trim());
  return parts.filter((part) => part !== "");
}

/** Index of the `)` that closes the `(` at `openIndex`, or -1 when it is not closed. */
export function findClosingParen(text: string, openIndex: number, dialect: SqlDialect): number {
  let depth = 0;
  for (const range of tokenize(text, dialect)) {
    if (range.kind !== "code" || range.end <= openIndex) continue;
    for (let index = Math.max(range.start, openIndex); index < range.end; index += 1) {
      if (text[index] === "(") depth += 1;
      else if (text[index] === ")") {
        depth -= 1;
        if (depth === 0) return index;
      }
    }
  }
  return -1;
}
