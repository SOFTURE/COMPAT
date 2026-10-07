import {
  IDENTIFIER_PATTERN,
  NAME_PATTERN,
  parseName,
  type SqlName,
  unquoteIdentifier,
} from "../../sql/identifiers.js";
import {
  findClosingParen,
  maskLiterals,
  type SqlDialect,
  splitStatements,
  splitTopLevel,
} from "../../sql/statements.js";

/**
 * Reads a seed script (a script that runs on every deploy) into the statements that write rows.
 * Row-bearing statements keep one entry per row with its key, so two versions of a seed can be
 * compared row by row; other writes keep their normalised text.
 */

/** What a statement does when the row already exists: overwrite it, leave it, or nothing guards it. */
export type ConflictMode = "update" | "ignore" | "none";

export type SeedRow = {
  /** Normalised values of the key columns, joined with `, `. */
  key: string;
  /** Normalised values of the whole row, joined with `, `. */
  values: string;
  /** 1-based line of the row's tuple. */
  line: number;
};

export type SeedStatement =
  | {
      kind: "rows";
      table: SqlName;
      /** Column names as written (unquoted); empty when the statement has no column list. */
      columns: string[];
      /** Columns the row key is made of, as written; `[]` with no column list (the first value is the key). */
      keyColumns: string[];
      rows: SeedRow[];
      mode: ConflictMode;
      /** `MERGE ... WHEN NOT MATCHED BY SOURCE THEN DELETE`: rows missing from the source are deleted. */
      deletesMissing: boolean;
      /**
       * The normalised `IF NOT EXISTS (...)` condition when the mode comes from such a guard: it checks
       * once for the whole block, so a row added under a guard the base already had never reaches
       * databases where the guard is false.
       */
      guard: string | null;
      /** Normalised text of what the statement does with its rows (`ON CONFLICT ...`, the `MERGE` clauses). */
      action: string;
      line: number;
    }
  | {
      kind: "insert-query";
      table: SqlName;
      mode: ConflictMode;
      /** Normalised text, prefixed with the `IF NOT EXISTS` guard when one applies. */
      text: string;
      line: number;
    }
  | {
      kind: "merge-query";
      table: SqlName;
      updates: boolean;
      deletes: boolean;
      inserts: boolean;
      text: string;
      line: number;
    }
  | { kind: "update" | "delete" | "truncate"; table: SqlName; text: string; line: number }
  /**
   * A statement that writes rows in a shape the reader does not know: a CTE, dynamic SQL without a
   * literal body, `COPY ... FROM`, `BULK INSERT`, nested SQL beyond the nesting limit.
   */
  | { kind: "unknown-write"; text: string; line: number };

/** Nested SQL (a `DO` body, a dynamic-SQL literal) is unwrapped at most this deep. */
const MAX_NESTING = 3;

const NAME = NAME_PATTERN;
const IDENT = IDENTIFIER_PATTERN;
const TOP = "(?:TOP\\s*\\([^)]*\\)\\s+)?";

const pattern = (source: string) => new RegExp(source, "is");

const INSERT = pattern(`^INSERT\\s+(?:INTO\\s+)?(${NAME})(?:\\s+AS\\s+(?!VALUES\\b|SELECT\\b)${IDENT})?\\s*`);
const MERGE = pattern(
  `^MERGE\\s+${TOP}(?:INTO\\s+)?(${NAME})(?:\\s+WITH\\s*\\([^)]*\\))?(?:\\s+(?:AS\\s+)?(?!USING\\b)${IDENT})?\\s+USING\\s+`,
);
const UPDATE = pattern(`^UPDATE\\s+${TOP}(?:ONLY\\s+)?(${NAME})`);
const DELETE = pattern(`^DELETE\\s+${TOP}(?:FROM\\s+)?(?:ONLY\\s+)?(${NAME})`);
const TRUNCATE = pattern(`^TRUNCATE\\s+(?:TABLE\\s+)?(?:ONLY\\s+)?(${NAME})`);
const DO_BLOCK = pattern("^DO\\s+(?:LANGUAGE\\s+\\w+\\s+)?(\\$\\w*\\$)(.*)\\1(?:\\s+LANGUAGE\\s+\\w+)?$");
const ON_CONFLICT = pattern("\\bON\\s+CONFLICT\\b(.*?)\\bDO\\s+(UPDATE|NOTHING)\\b");
const WHERE_NOT_EXISTS = pattern("\\bWHERE\\s+NOT\\s+EXISTS\\s*\\(");
const MERGE_CLAUSE =
  /\bWHEN\s+(NOT\s+MATCHED(?:\s+BY\s+(SOURCE|TARGET))?|MATCHED)\b.*?\bTHEN\s+(UPDATE|DELETE|INSERT|DO\s+NOTHING)\b/gis;
const ON_PAIR = new RegExp(`(${IDENT})\\s*\\.\\s*(${IDENT})\\s*=\\s*(${IDENT})\\s*\\.\\s*(${IDENT})`, "g");
const BEGIN_BLOCK = /^BEGIN\b(?!\s+(?:TRAN|TRANSACTION|DISTRIBUTED)\b)(?:\s+(?:TRY|CATCH)\b)?\s*/i;
const END_BLOCK: Record<SqlDialect, RegExp> = {
  postgres: /^END\b(?:\s+(?:IF|LOOP)\b)?\s*/i,
  sqlserver: /^END\b(?:\s+(?:TRY|CATCH)\b)?\s*/i,
};
const ELSE = /^ELSE\b\s*/i;
const ELSIF = /^ELS(?:E\s+)?IF\b/i;
const IF_NOT_EXISTS = /^IF\s+NOT\s+EXISTS\s*\(/i;
const LOOP_OPENER = /^(?:WHILE|FOR|FOREACH|LOOP)\b/i;
/**
 * Words that start a T-SQL statement at the start of a line. Semicolons are optional in T-SQL, so
 * a line starting with one of them ends the statement before it. `SET` counts only for session
 * options and variables, so the `SET` clause of an `UPDATE` on its own line does not split it.
 */
const TSQL_LINE_STATEMENT =
  /^(?:INSERT|UPDATE|DELETE|MERGE|TRUNCATE|IF|ELSE|WHILE|BEGIN|END|PRINT|DECLARE|EXEC|EXECUTE|RAISERROR|THROW|RETURN|COMMIT|ROLLBACK|GO|SET\s+(?:@|IDENTITY_INSERT\b|NOCOUNT\b|XACT_ABORT\b|ANSI_\w+|QUOTED_IDENTIFIER\b|ARITHABORT\b|LANGUAGE\b|DATEFORMAT\b|DEADLOCK_PRIORITY\b|LOCK_TIMEOUT\b|TRANSACTION\b))\b/i;
const WRITE_WORD = /\b(?:INSERT|UPDATE|DELETE|MERGE|TRUNCATE)\b/i;
const NOT_A_WRITE = /^(?:GRANT|REVOKE|CREATE|ALTER|DROP|COMMENT|EXPLAIN)\b/i;
/** T-SQL `EXEC (...)`: dynamic SQL given as an expression in parentheses. */
const TSQL_EXEC_EXPRESSION = /^EXEC(?:UTE)?\s*\(/i;
/** T-SQL `EXEC sp_executesql`, optionally schema-qualified, with an optional `@stmt =` name. */
const TSQL_SP_EXECUTESQL =
  /^EXEC(?:UTE)?\s+(?:(?:\[?\w+\]?)?\.){0,2}\[?sp_executesql\]?(?![\w$#@])\s*(?:@stmt\s*=\s*)?/i;
/** PL/pgSQL `EXECUTE <expression>` inside a `DO` body. */
const PLPGSQL_EXECUTE = /^EXECUTE\b\s*/i;
/** What may follow the literal of a PL/pgSQL `EXECUTE` without changing the executed text. */
const PLPGSQL_EXECUTE_TAIL = /^(?:$|(?:USING|INTO)\b)/i;
const DOLLAR_QUOTE = /^\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$/;

/** A string literal: its unescaped text, the offset of its first character of text, and the index after it. */
type Literal = { text: string; offset: number; end: number };

/**
 * Dynamic SQL found at the start of a statement: a body given as one literal, or an expression the
 * reader cannot evaluate (a variable, a concatenation, a `format(...)` call).
 */
type DynamicSql = { kind: "literal"; literal: Literal } | { kind: "expression"; firstLiteral: string | null };

/** An open `IF`/`BEGIN` block; `guard` is the normalised `IF NOT EXISTS (...)` condition of a guarding block. */
type Block = { guard: string | null };

type Piece = { sql: string; line: number };

/**
 * Collapses whitespace outside quotes, drops it around `(`, `)` and `,`, and uppercases text outside
 * quotes, so formatting and keyword case do not count.
 */
export function normalizeSql(text: string, dialect: SqlDialect): string {
  let result = "";
  let pendingSpace = false;
  let index = 0;
  const closers: Record<string, string> = { "'": "'", '"': '"' };
  if (dialect === "sqlserver") closers["["] = "]";
  const flushSpace = (next: string) => {
    if (pendingSpace && result !== "" && !/[(,]$/.test(result) && !/^[),]/.test(next)) result += " ";
    pendingSpace = false;
  };
  while (index < text.length) {
    const char = text[index] as string;
    const close = closers[char];
    if (close !== undefined) {
      let end = index + 1;
      while (end < text.length) {
        if (text[end] === close) {
          if (text[end + 1] === close) {
            end += 2;
            continue;
          }
          break;
        }
        end += 1;
      }
      const quoted = text.slice(index, end + 1);
      flushSpace(quoted);
      result += quoted;
      index = end + 1;
      continue;
    }
    if (/\s/.test(char)) {
      pendingSpace = true;
      index += 1;
      continue;
    }
    flushSpace(char);
    // Keywords and unquoted names are case-insensitive in both dialects.
    result += char.toUpperCase();
    index += 1;
  }
  return result;
}

function countNewlines(text: string): number {
  let count = 0;
  for (const char of text) if (char === "\n") count += 1;
  return count;
}

/** Text after `prefixLength` characters of `piece`, trimmed, with its true line. */
function getRest(piece: Piece, prefixLength: number): Piece {
  const rest = piece.sql.slice(prefixLength);
  const leading = rest.length - rest.trimStart().length;
  return {
    sql: rest.trim(),
    line: piece.line + countNewlines(piece.sql.slice(0, prefixLength + leading)),
  };
}

/**
 * When a string or quoted identifier starts at `index`, the index just after it; otherwise -1.
 * Postgres `E'...'` strings use backslash escapes.
 */
function skipQuoted(text: string, index: number, dialect: SqlDialect): number {
  const char = text[index];
  if (char !== "'" && char !== '"' && !(char === "[" && dialect === "sqlserver")) return -1;
  const close = char === "[" ? "]" : char;
  const hasBackslashEscapes =
    char === "'" &&
    dialect === "postgres" &&
    /[Ee]/.test(text[index - 1] ?? "") &&
    !/[\w$]/.test(text[index - 2] ?? "");
  let end = index + 1;
  while (end < text.length) {
    if (hasBackslashEscapes && text[end] === "\\") {
      end += 2;
      continue;
    }
    if (text[end] === close) {
      if (text[end + 1] !== close) return end + 1;
      end += 2;
      continue;
    }
    end += 1;
  }
  return text.length;
}

/** Index of the `)` closing the `(` at `open`, scanning only from `open` (linear for long `VALUES` lists); -1 when unclosed. */
function findTupleClose(text: string, open: number, dialect: SqlDialect): number {
  let depth = 0;
  let index = open;
  while (index < text.length) {
    const quotedEnd = skipQuoted(text, index, dialect);
    if (quotedEnd !== -1) {
      index = quotedEnd;
      continue;
    }
    if (text[index] === "(") depth += 1;
    else if (text[index] === ")") {
      depth -= 1;
      if (depth === 0) return index;
    }
    index += 1;
  }
  return -1;
}

/**
 * Index of the first occurrence of `word` (a regular-expression source matched as a whole word) at
 * parenthesis depth 0 and outside quotes, or -1.
 */
function findTopLevelWord(text: string, word: RegExp, dialect: SqlDialect): number {
  let depth = 0;
  let index = 0;
  while (index < text.length) {
    const char = text[index] as string;
    const quotedEnd = skipQuoted(text, index, dialect);
    if (quotedEnd !== -1) {
      index = quotedEnd;
      continue;
    }
    if (char === "(") depth += 1;
    else if (char === ")") depth -= 1;
    else if (depth === 0 && !/[\w$#@]/.test(text[index - 1] ?? " ")) {
      const match = word.exec(text.slice(index));
      if (match && match.index === 0) return index;
    }
    index += 1;
  }
  return -1;
}

/**
 * The statements of a `DO` body: from the first `BEGIN` to the `EXCEPTION` or `END` of that same
 * block. Nested `BEGIN ... END` blocks and `CASE ... END` expressions are counted, so an inner
 * `EXCEPTION` does not cut the body short.
 */
function getDoBody(body: string, dialect: SqlDialect): { text: string; offset: number } | null {
  const begin = /\bBEGIN\b/i.exec(body);
  if (!begin) return null;
  const start = begin.index + begin[0].length;
  const words = /\b(?:BEGIN|CASE|END(?:\s+(?:IF|LOOP|CASE)\b)?|EXCEPTION)\b/giy;
  let depth = 1;
  let index = start;
  while (index < body.length) {
    const quotedEnd = skipQuoted(body, index, dialect);
    if (quotedEnd !== -1) {
      index = quotedEnd;
      continue;
    }
    words.lastIndex = index;
    const word = /[\w$]/.test(body[index - 1] ?? " ") ? null : words.exec(body);
    if (!word) {
      index += 1;
      continue;
    }
    const upper = word[0].toUpperCase().replace(/\s+/g, " ");
    if (upper === "BEGIN" || upper === "CASE") depth += 1;
    else if (upper === "END") depth -= 1;
    else if (upper === "END CASE") depth -= 1;
    if ((upper === "EXCEPTION" && depth === 1) || depth === 0) {
      return { text: body.slice(start, index), offset: start };
    }
    index += word[0].length;
  }
  return { text: body.slice(start), offset: start };
}

/** Reads the `VALUES` tuples starting at `start`; `null` when any tuple cannot be read. */
function readTuples(
  sql: string,
  start: number,
  dialect: SqlDialect,
): { tuples: { values: string[]; offset: number }[]; end: number } | null {
  const tuples: { values: string[]; offset: number }[] = [];
  let index = start;
  while (true) {
    while (/\s/.test(sql[index] ?? "")) index += 1;
    if (sql[index] !== "(") return null;
    const close = findTupleClose(sql, index, dialect);
    if (close === -1) return null;
    tuples.push({
      values: splitTopLevel(sql.slice(index + 1, close), dialect).map((value) =>
        normalizeSql(value, dialect),
      ),
      offset: index,
    });
    index = close + 1;
    while (/\s/.test(sql[index] ?? "")) index += 1;
    if (sql[index] !== ",") return { tuples, end: index };
    index += 1;
  }
}

function sameColumn(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

/** Positions of `keyColumns` in `columns`; position 0 when the key cannot be found. */
function getKeyIndexes(columns: string[], keyColumns: string[]): number[] {
  const indexes = keyColumns.map((key) => columns.findIndex((column) => sameColumn(column, key)));
  return indexes.length > 0 && indexes.every((index) => index !== -1) ? indexes : [0];
}

function buildRows(
  piece: Piece,
  tuples: { values: string[]; offset: number }[],
  keyIndexes: number[],
): SeedRow[] {
  return tuples.map(({ values, offset }) => ({
    key: keyIndexes.map((index) => values[index] ?? "").join(", "),
    values: values.join(", "),
    line: piece.line + countNewlines(piece.sql.slice(0, offset)),
  }));
}

function readColumns(sql: string, start: number, dialect: SqlDialect): { columns: string[]; end: number } {
  let index = start;
  while (/\s/.test(sql[index] ?? "")) index += 1;
  if (sql[index] !== "(") return { columns: [], end: start };
  const close = findClosingParen(sql, index, dialect);
  if (close === -1) return { columns: [], end: start };
  return {
    columns: splitTopLevel(sql.slice(index + 1, close), dialect).map(unquoteIdentifier),
    end: close + 1,
  };
}

/** `INSERT ... SELECT ... WHERE NOT EXISTS (...)` whose subquery reads the target table. */
function isGuardedQuery(query: string, table: SqlName): boolean {
  const notExists = WHERE_NOT_EXISTS.exec(query);
  if (!notExists) return false;
  const name = table.parts[table.parts.length - 1] ?? "";
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?:^|[^\\w$#@])${escaped}(?:$|[^\\w$#@])`, "i").test(query.slice(notExists.index));
}

function readInsert(
  piece: Piece,
  match: RegExpExecArray,
  guard: string | null,
  dialect: SqlDialect,
): SeedStatement {
  const { sql, line } = piece;
  const table = parseName(match[1] as string, dialect);
  const { columns, end: columnsEnd } = readColumns(sql, match[0].length, dialect);
  const afterColumns = sql
    .slice(columnsEnd)
    .replace(/^\s*OVERRIDING\s+(?:SYSTEM|USER)\s+VALUE\b/i, "")
    .trimStart();
  const sourceStart = sql.length - afterColumns.length;
  const values = /^VALUES\b/i.exec(afterColumns);
  const tuples = values ? readTuples(sql, sourceStart + values[0].length, dialect) : null;
  const tail = tuples ? sql.slice(tuples.end) : afterColumns;
  const conflict = ON_CONFLICT.exec(tail);
  let mode: ConflictMode = "none";
  if (conflict) mode = (conflict[2] as string).toUpperCase() === "UPDATE" ? "update" : "ignore";
  else if (guard !== null || (!tuples && isGuardedQuery(afterColumns, table))) mode = "ignore";
  if (!tuples) {
    const text = normalizeSql(sql, dialect);
    return {
      kind: "insert-query",
      table,
      mode,
      text: guard === null ? text : `IF NOT EXISTS ${guard} ${text}`,
      line,
    };
  }
  const target = conflict ? /^\s*\(([^)]*)\)/.exec(conflict[1] as string) : null;
  const conflictColumns = target ? splitTopLevel(target[1] as string, dialect).map(unquoteIdentifier) : [];
  const keyIndexes = getKeyIndexes(columns, conflictColumns);
  return {
    kind: "rows",
    table,
    columns,
    keyColumns: columns.length === 0 ? [] : keyIndexes.map((index) => columns[index] as string),
    rows: buildRows(piece, tuples.tuples, keyIndexes),
    mode,
    deletesMissing: false,
    guard: conflict ? null : guard,
    action: normalizeSql(tail, dialect),
    line,
  };
}

function readMerge(piece: Piece, match: RegExpExecArray, dialect: SqlDialect): SeedStatement {
  const { sql, line } = piece;
  const table = parseName(match[1] as string, dialect);
  const clauses = [...sql.matchAll(MERGE_CLAUSE)].map((clause) => ({
    matched: !/^NOT\b/i.test(clause[1] as string),
    bySource: (clause[2] ?? "").toUpperCase() === "SOURCE",
    action: (clause[3] as string).toUpperCase().replace(/\s+/g, " "),
  }));
  const updates = clauses.some((clause) => clause.action === "UPDATE");
  const deletesMatched = clauses.some((clause) => clause.matched && clause.action === "DELETE");
  const deletesMissing = clauses.some((clause) => clause.bySource && clause.action === "DELETE");
  const inserts = clauses.some((clause) => !clause.matched && !clause.bySource && clause.action === "INSERT");
  const query: SeedStatement = {
    kind: "merge-query",
    table,
    updates,
    deletes: deletesMatched || deletesMissing,
    inserts,
    text: normalizeSql(sql, dialect),
    line,
  };
  const sourceOpen = match[0].length;
  if (sql[sourceOpen] !== "(" || deletesMatched || (!updates && !inserts)) return query;
  const sourceClose = findClosingParen(sql, sourceOpen, dialect);
  if (sourceClose === -1) return query;
  const inner = sql.slice(sourceOpen + 1, sourceClose);
  const values = /^\s*VALUES\b/i.exec(inner);
  if (!values) return query;
  const tuples = readTuples(sql, sourceOpen + 1 + values[0].length, dialect);
  if (!tuples || sql.slice(tuples.end, sourceClose).trim() !== "") return query;
  const alias = pattern(`^\\s*(?:AS\\s+)?(${IDENT})`).exec(sql.slice(sourceClose + 1));
  if (!alias) return query;
  const sourceAlias = unquoteIdentifier(alias[1] as string);
  const { columns, end: columnsEnd } = readColumns(sql, sourceClose + 1 + alias[0].length, dialect);
  const whenIndex = sql.search(/\bWHEN\b/i);
  const condition = sql.slice(sourceClose + 1, whenIndex === -1 ? sql.length : whenIndex);
  const keyColumns: string[] = [];
  for (const pair of condition.matchAll(ON_PAIR)) {
    const [left, leftColumn, right, rightColumn] = [pair[1], pair[2], pair[3], pair[4]].map((part) =>
      unquoteIdentifier(part as string),
    ) as [string, string, string, string];
    if (sameColumn(left, sourceAlias)) keyColumns.push(leftColumn);
    else if (sameColumn(right, sourceAlias)) keyColumns.push(rightColumn);
  }
  const keyIndexes = getKeyIndexes(columns, keyColumns);
  return {
    kind: "rows",
    table,
    columns,
    keyColumns: columns.length === 0 ? [] : keyIndexes.map((index) => columns[index] as string),
    rows: buildRows(piece, tuples.tuples, keyIndexes),
    mode: updates ? "update" : "ignore",
    deletesMissing,
    guard: null,
    action: normalizeSql(sql.slice(Math.max(columnsEnd, sourceClose + 1 + alias[0].length)), dialect),
    line,
  };
}

/**
 * Reads the string literal starting at `start` (after whitespace): `'...'`, T-SQL `N'...'` or a
 * Postgres dollar quote. `null` for anything else, including Postgres `E'...'`, whose backslash
 * escapes could change the text and its lines.
 */
function readLiteral(sql: string, start: number, dialect: SqlDialect): Literal | null {
  let index = start;
  while (/\s/.test(sql[index] ?? "")) index += 1;
  if (dialect === "sqlserver" && /[Nn]/.test(sql[index] ?? "") && sql[index + 1] === "'") index += 1;
  if (sql[index] === "'") {
    const end = skipQuoted(sql, index, dialect);
    if (end > sql.length || sql[end - 1] !== "'" || end - index < 2) return null;
    return { text: sql.slice(index + 1, end - 1).replaceAll("''", "'"), offset: index + 1, end };
  }
  const tag = dialect === "postgres" ? DOLLAR_QUOTE.exec(sql.slice(index))?.[0] : undefined;
  if (tag === undefined) return null;
  const close = sql.indexOf(tag, index + tag.length);
  if (close === -1) return null;
  return { text: sql.slice(index + tag.length, close), offset: index + tag.length, end: close + tag.length };
}

/** The text of the first string literal in `text`, or `null`. */
function findFirstLiteral(text: string, dialect: SqlDialect): string | null {
  const quote = text.indexOf("'");
  if (quote === -1) return null;
  return text.slice(quote + 1, skipQuoted(text, quote, dialect) - 1);
}

/** Reads `expression` (the text after the dynamic-SQL keyword) as one literal followed by `isTail`, or as an expression. */
function readDynamicBody(
  sql: string,
  start: number,
  dialect: SqlDialect,
  isTail: (rest: string) => boolean,
): DynamicSql {
  const literal = readLiteral(sql, start, dialect);
  if (literal && isTail(sql.slice(literal.end).trim())) return { kind: "literal", literal };
  return { kind: "expression", firstLiteral: findFirstLiteral(sql.slice(start), dialect) };
}

/**
 * Dynamic SQL at the start of `piece`: T-SQL `EXEC (...)` and `EXEC sp_executesql`, and PL/pgSQL
 * `EXECUTE` inside a `DO` body (a top-level Postgres `EXECUTE` runs a prepared statement). `null`
 * for anything else, including a T-SQL procedure call.
 */
function findDynamicSql(sql: string, dialect: SqlDialect, depth: number): DynamicSql | null {
  if (dialect === "sqlserver") {
    const expression = TSQL_EXEC_EXPRESSION.exec(sql);
    if (expression) {
      const open = expression[0].length - 1;
      const close = findClosingParen(sql, open, dialect);
      const inner = close === -1 ? sql.length : close;
      return readDynamicBody(sql.slice(0, inner), open + 1, dialect, (rest) => rest === "");
    }
    const procedure = TSQL_SP_EXECUTESQL.exec(sql);
    if (!procedure) return null;
    return readDynamicBody(sql, procedure[0].length, dialect, (rest) => rest === "" || rest.startsWith(","));
  }
  const execute = depth > 0 ? PLPGSQL_EXECUTE.exec(sql) : null;
  if (!execute) return null;
  return readDynamicBody(sql, execute[0].length, dialect, (rest) => PLPGSQL_EXECUTE_TAIL.test(rest));
}

/** Reads one statement without block keywords; `null` when it writes no rows the layer tracks. */
function readWrite(piece: Piece, guard: string | null, dialect: SqlDialect): SeedStatement | null {
  const { sql, line } = piece;
  const insert = INSERT.exec(sql);
  if (insert) return readInsert(piece, insert, guard, dialect);
  const merge = MERGE.exec(sql);
  if (merge) return readMerge(piece, merge, dialect);
  const simple: [RegExp, "update" | "delete" | "truncate"][] = [
    [UPDATE, "update"],
    [DELETE, "delete"],
    [TRUNCATE, "truncate"],
  ];
  for (const [regex, kind] of simple) {
    const found = regex.exec(sql);
    if (found) {
      const table = parseName(found[1] as string, dialect);
      return { kind, table, text: normalizeSql(sql, dialect), line };
    }
  }
  return null;
}

/** State shared by the statements of one sequence (a script, or one `DO` body). */
type Reader = { dialect: SqlDialect; depth: number; blocks: Block[]; out: SeedStatement[] };

/** The condition of the innermost open guarding block, or `null`. */
function getGuard(reader: Reader): string | null {
  for (let index = reader.blocks.length - 1; index >= 0; index -= 1) {
    const guard = reader.blocks[index]?.guard;
    if (guard) return guard;
  }
  return null;
}

/**
 * Reads one piece of a statement: strips block keywords (`BEGIN`, `END`, `ELSE`, `IF ... THEN`,
 * T-SQL `IF <condition>`) and reads what follows them.
 */
function readPiece(reader: Reader, piece: Piece, inlineGuard: string | null = null): void {
  const { dialect } = reader;
  const { sql } = piece;
  if (sql === "") return;

  const end = END_BLOCK[dialect].exec(sql);
  if (end) {
    reader.blocks.pop();
    readPiece(reader, getRest(piece, end[0].length));
    return;
  }
  const begin = BEGIN_BLOCK.exec(sql);
  if (begin) {
    reader.blocks.push({ guard: inlineGuard });
    readPiece(reader, getRest(piece, begin[0].length));
    return;
  }
  // In PL/pgSQL the IF block is still open at ELSE/ELSIF; in T-SQL the IF block already ended.
  if (dialect === "postgres" && ELSIF.test(sql)) {
    const top = reader.blocks[reader.blocks.length - 1];
    if (top) top.guard = null;
    const then = findTopLevelWord(sql, /^THEN\b/i, dialect);
    if (then !== -1) readPiece(reader, getRest(piece, then + 4));
    return;
  }
  const elseMatch = ELSE.exec(sql);
  if (elseMatch) {
    const top = reader.blocks[reader.blocks.length - 1];
    if (top && dialect === "postgres") top.guard = null;
    readPiece(reader, getRest(piece, elseMatch[0].length));
    return;
  }
  if (/^IF\b/i.test(sql) || (dialect === "sqlserver" && /^WHILE\b/i.test(sql))) {
    readIf(reader, piece);
    return;
  }
  if (dialect === "postgres" && LOOP_OPENER.test(sql)) {
    const loop = findTopLevelWord(sql, /^LOOP\b/i, dialect);
    if (loop === -1) return;
    reader.blocks.push({ guard: null });
    readPiece(reader, getRest(piece, loop + 4));
    return;
  }
  if (dialect === "postgres") {
    const doBlock = DO_BLOCK.exec(sql);
    if (doBlock) {
      readDoBlock(reader, piece, doBlock);
      return;
    }
  }
  if (dialect === "sqlserver") {
    const next = findNextTsqlStatement(sql);
    if (next !== -1) {
      readPiece(reader, { sql: sql.slice(0, next).trimEnd(), line: piece.line }, inlineGuard);
      readPiece(reader, getRest(piece, next));
      return;
    }
  }
  const guard = inlineGuard ?? getGuard(reader);
  const dynamic = findDynamicSql(sql, dialect, reader.depth);
  if (dynamic) {
    readDynamicSql(reader, piece, dynamic, guard);
    return;
  }
  if (dialect === "postgres" && /^COPY\b/i.test(sql) && findTopLevelWord(sql, /^FROM\b/i, dialect) !== -1) {
    // `COPY ... FROM` loads rows from a file or the client that the seed layer cannot see.
    pushUnknownWrite(reader, piece);
    return;
  }
  const write = readWrite(piece, guard, dialect);
  if (write) reader.out.push(write);
  else if (
    !NOT_A_WRITE.test(sql) &&
    WRITE_WORD.test(maskLiterals(sql, dialect).replace(/\bFOR\s+UPDATE\b/gi, ""))
  ) {
    pushUnknownWrite(reader, piece);
  }
}

function pushUnknownWrite(reader: Reader, piece: Piece): void {
  reader.out.push({ kind: "unknown-write", text: normalizeSql(piece.sql, reader.dialect), line: piece.line });
}

/**
 * Reads the literal body of dynamic SQL as a nested sequence that keeps the outer file's lines and
 * the current guard. A body the reader cannot evaluate is an unknown write, unless its text starts
 * with a statement that writes no rows (`EXECUTE format('CREATE INDEX ...')`).
 */
function readDynamicSql(reader: Reader, piece: Piece, dynamic: DynamicSql, guard: string | null): void {
  if (dynamic.kind === "expression") {
    if (!NOT_A_WRITE.test(dynamic.firstLiteral?.trimStart() ?? "")) pushUnknownWrite(reader, piece);
    return;
  }
  if (reader.depth >= MAX_NESTING) {
    pushUnknownWrite(reader, piece);
    return;
  }
  const { literal } = dynamic;
  const line = piece.line + countNewlines(piece.sql.slice(0, literal.offset));
  const blocks = guard === null ? [] : [{ guard }];
  readSequence({ ...reader, depth: reader.depth + 1, blocks }, literal.text, line);
}

/**
 * Offset of the next T-SQL statement inside `sql` (a line starting with a statement word, outside
 * parentheses, quotes and `CASE ... END`, not right after a `MERGE` clause's `THEN`), or -1.
 */
function findNextTsqlStatement(sql: string): number {
  let depth = 0;
  let caseDepth = 0;
  let isLineStart = false;
  let index = 0;
  while (index < sql.length) {
    const char = sql[index] as string;
    const quotedEnd = skipQuoted(sql, index, "sqlserver");
    if (quotedEnd !== -1) {
      index = quotedEnd;
      isLineStart = false;
      continue;
    }
    if (char === "\n") {
      isLineStart = true;
      index += 1;
      continue;
    }
    if (/\s/.test(char)) {
      index += 1;
      continue;
    }
    const rest = sql.slice(index);
    if (
      isLineStart &&
      depth === 0 &&
      caseDepth === 0 &&
      TSQL_LINE_STATEMENT.test(rest) &&
      !/\bTHEN\s*$/i.test(sql.slice(0, index))
    ) {
      return index;
    }
    isLineStart = false;
    if (char === "(") depth += 1;
    else if (char === ")") depth -= 1;
    else if (!/[\w$#@]/.test(sql[index - 1] ?? " ")) {
      if (/^CASE\b/i.test(rest)) caseDepth += 1;
      else if (caseDepth > 0 && /^END\b/i.test(rest)) caseDepth -= 1;
    }
    index += 1;
  }
  return -1;
}

function readIf(reader: Reader, piece: Piece): void {
  const { dialect } = reader;
  const { sql } = piece;
  let conditionEnd: number;
  const isWhile = /^WHILE\b/i.test(sql);
  let guard: string | null = null;
  const notExists = IF_NOT_EXISTS.exec(sql);
  if (notExists) {
    const open = notExists[0].length - 1;
    const close = findClosingParen(sql, open, dialect);
    if (close === -1) return;
    conditionEnd = close + 1;
    const after = sql.slice(conditionEnd);
    // Only a bare `IF NOT EXISTS (...)` guards; `IF NOT EXISTS (...) AND ...` is some other condition.
    if (/^\s*(?:THEN\b|BEGIN\b|INSERT\b|MERGE\b|EXEC(?:UTE)?\b|$)/i.test(after)) {
      guard = normalizeSql(sql.slice(open, conditionEnd), dialect);
    }
  } else {
    conditionEnd = isWhile ? 5 : 2;
  }
  if (dialect === "postgres") {
    const then = findTopLevelWord(sql.slice(conditionEnd), /^THEN\b/i, dialect);
    if (then === -1) return;
    reader.blocks.push({ guard });
    readPiece(reader, getRest(piece, conditionEnd + then + 4));
    return;
  }
  const start = findTopLevelWord(
    sql.slice(conditionEnd),
    /^(?:BEGIN|INSERT|UPDATE|DELETE|MERGE|TRUNCATE|SET|EXEC|EXECUTE|SELECT|PRINT|THROW|RAISERROR|RETURN|DECLARE)\b/i,
    dialect,
  );
  if (start === -1) return;
  readPiece(reader, getRest(piece, conditionEnd + start), guard);
}

function readDoBlock(reader: Reader, piece: Piece, doBlock: RegExpExecArray): void {
  if (reader.depth >= MAX_NESTING) {
    pushUnknownWrite(reader, piece);
    return;
  }
  const tag = doBlock[1] as string;
  const bodyStart = piece.sql.indexOf(tag) + tag.length;
  const body = getDoBody(doBlock[2] as string, reader.dialect);
  if (!body) return;
  const offset = bodyStart + body.offset;
  const bodyLine = piece.line + countNewlines(piece.sql.slice(0, offset));
  readSequence({ ...reader, depth: reader.depth + 1, blocks: [] }, body.text, bodyLine);
}

function readSequence(reader: Reader, text: string, firstLine: number): void {
  for (const statement of splitStatements(text, reader.dialect)) {
    readPiece(reader, { sql: statement.sql, line: firstLine + statement.line - 1 });
  }
}

/** The row-writing statements of a seed script, in order. */
export function readSeedStatements(text: string, dialect: SqlDialect): SeedStatement[] {
  const out: SeedStatement[] = [];
  readSequence({ dialect, depth: 0, blocks: [], out }, text, 1);
  return out;
}
