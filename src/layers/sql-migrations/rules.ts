import type { FindingClass } from "../../model/finding.js";
import {
  IDENTIFIER_PATTERN,
  NAME_PATTERN,
  parseName,
  type SqlName,
  unescapeSqlString,
  unquoteIdentifier,
} from "../../sql/identifiers.js";
import { findClosingParen, maskLiterals, type SqlDialect, splitTopLevel } from "../../sql/statements.js";

export const RULE_CLASSES = {
  "create-schema": "safe",
  "create-table": "safe",
  "add-column": "safe",
  "add-required-column": "breaking",
  "create-index": "safe",
  "add-unique-index": "needs-action",
  "add-constraint": "needs-action",
  "drop-table": "breaking",
  "drop-column": "breaking",
  "drop-object": "breaking",
  "rename-table": "breaking",
  "rename-column": "breaking",
  "move-table": "breaking",
  "change-column-type": "breaking",
  "alter-column": "breaking",
  "set-not-null": "breaking",
  "drop-not-null": "rollback-risk",
  "drop-default": "needs-action",
  "enum-value-added": "rollback-risk",
  "enum-value-renamed": "breaking",
  truncate: "breaking",
  "update-data": "needs-action",
  "delete-data": "needs-action",
  "merge-data": "needs-action",
  "insert-explicit-id": "needs-action",
  "object-redefined": "needs-action",
} as const satisfies Record<string, FindingClass>;

export type RuleId = keyof typeof RULE_CLASSES;

export type RuleMatch = {
  kind: "rule";
  rule: RuleId;
  class: FindingClass;
  /** The table the statement changes, when it changes one; used to recognise tables created by the same migrations. */
  table: SqlName | null;
  /** `table` or `table.column` as written. */
  object: string;
  message: string;
  /** `create-table` only: written as `CREATE TABLE IF NOT EXISTS`, so the table may exist already. */
  ifNotExists?: boolean;
  /** `rename-table` only: the new name. */
  renamedTo?: SqlName;
  /** `drop-object` only: the key of the dropped object, to recognise a redefinition. */
  droppedObject?: string;
  /** `insert-explicit-id` only: what was inserted, so inserts into one table can be merged. */
  explicitIds?: ExplicitIds;
};

/** What explicit-id inserts into one table wrote; summaries of several inserts merge with `mergeExplicitIds`. */
export type ExplicitIds = {
  /** The id column as written, or `null` when only `IDENTITY_INSERT` says that ids are explicit. */
  column: string | null;
  /** Number of rows, or `null` when it cannot be read (`INSERT ... SELECT`). */
  rows: number | null;
  /** Lowest and highest id when every id is an integer literal, otherwise `null`. */
  range: { first: number; last: number } | null;
};

export type StatementMatch =
  | RuleMatch
  /** `SET IDENTITY_INSERT <table> ON|OFF`: while on, inserts into the table in the same migration carry explicit ids. */
  | { kind: "identity-insert"; table: SqlName; isEnabled: boolean }
  /**
   * SQL to split and match again: the literal of `EXEC(N'...')` (offset `null`, evidence at the
   * statement's line) or the body of a `DO` block, an `IF ... THEN` or a T-SQL `IF <condition>`
   * (offset of the body in the statement).
   */
  | { kind: "nested"; sql: string; offset: number | null };

export type MatchContext = {
  /** Keys (`SqlName.key`) of tables under `SET IDENTITY_INSERT ... ON` earlier in the same migration. */
  identityInsertTables: ReadonlySet<string>;
};

const NAME = NAME_PATTERN;
const IDENT = IDENTIFIER_PATTERN;
const STRING = "N?'(?:[^']|'')*'";
const TOP = "(?:TOP\\s*\\([^)]*\\)\\s+)?";

const pattern = (source: string) => new RegExp(source, "is");

const CREATE_SCHEMA = pattern(`^CREATE\\s+SCHEMA\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?(${IDENT})`);
const CREATE_TABLE = pattern(
  `^CREATE\\s+(?:(?:GLOBAL|LOCAL)\\s+)?(?:(?:TEMP|TEMPORARY|UNLOGGED)\\s+)?TABLE\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?(${NAME})`,
);
const CREATE_INDEX = pattern(
  `^CREATE\\s+(UNIQUE\\s+)?(?:(?:NON)?CLUSTERED\\s+)?INDEX\\s+(?:CONCURRENTLY\\s+)?(?:IF\\s+NOT\\s+EXISTS\\s+)?(?:(?!ON\\b)${NAME}\\s+)?ON\\s+(?:ONLY\\s+)?(${NAME})`,
);
const DROP_TABLE = pattern(`^DROP\\s+TABLE\\s+(?:IF\\s+EXISTS\\s+)?(${NAME}(?:\\s*,\\s*${NAME})*)`);
const DROP_OBJECT = pattern(
  `^DROP\\s+(MATERIALIZED\\s+VIEW|VIEW|FUNCTION|PROCEDURE|PROC|TYPE|SEQUENCE|SCHEMA)\\s+(?:IF\\s+EXISTS\\s+)?(${NAME})`,
);
const TRUNCATE = pattern(`^TRUNCATE\\s+(?:TABLE\\s+)?(?:ONLY\\s+)?(${NAME})`);
const UPDATE = pattern(`^UPDATE\\s+${TOP}(?:ONLY\\s+)?(${NAME})`);
const DELETE = pattern(`^DELETE\\s+${TOP}(?:FROM\\s+)?(?:ONLY\\s+)?(${NAME})`);
const MERGE = pattern(`^MERGE\\s+${TOP}(?:INTO\\s+)?(${NAME})`);
const INSERT = pattern(`^INSERT\\s+(?:INTO\\s+)?(${NAME})\\s*`);
const IDENTITY_INSERT = pattern(`^SET\\s+IDENTITY_INSERT\\s+(${NAME})\\s+(ON|OFF)\\b`);
const ALTER_TABLE = pattern(
  `^ALTER\\s+TABLE\\s+(?:IF\\s+EXISTS\\s+)?(?:ONLY\\s+)?(${NAME})\\s*\\*?\\s+(.*)$`,
);
const ALTER_TYPE = pattern(`^ALTER\\s+TYPE\\s+(${NAME})\\s+(ADD|RENAME)\\s+VALUE\\b`);
const SCHEMA_TRANSFER = pattern(`^ALTER\\s+SCHEMA\\s+${IDENT}\\s+TRANSFER\\s+(?:OBJECT\\s*::\\s*)?(${NAME})`);
const SP_RENAME = pattern(
  `^EXEC(?:UTE)?\\s+(?:\\[?sys\\]?\\s*\\.\\s*)?\\[?sp_rename\\]?\\s+(?:@objname\\s*=\\s*)?(${STRING})\\s*,\\s*(?:@newname\\s*=\\s*)?(${STRING})(?:\\s*,\\s*(?:@objtype\\s*=\\s*)?(${STRING}))?`,
);
const EXEC_LITERAL = pattern(`^EXEC(?:UTE)?\\s*\\(?\\s*(${STRING})\\s*\\)?$`);
const DO_BLOCK = pattern("^DO\\s+(?:LANGUAGE\\s+\\w+\\s+)?(\\$\\w*\\$)(.*)\\1(?:\\s+LANGUAGE\\s+\\w+)?$");
const DEFINED_OBJECT = pattern(
  `^CREATE\\s+(?:OR\\s+(?:REPLACE|ALTER)\\s+)?(MATERIALIZED\\s+VIEW|VIEW|FUNCTION|PROCEDURE|PROC|TYPE|SEQUENCE|SCHEMA)\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?(${NAME})`,
);
/** Words that start the statement a T-SQL `IF <condition>` runs. */
const TSQL_STATEMENT_START =
  /^(?:BEGIN|SET|EXEC|EXECUTE|INSERT|UPDATE|DELETE|MERGE|ALTER|CREATE|DROP|TRUNCATE|SELECT|PRINT|THROW|RAISERROR|RETURN|DECLARE)\b/i;
const CONSTRAINT_NAME_PREFIX = /^(?:PK|FK|AK|IX|DF|CK|UQ)_/i;

const ID_COLUMN = "id";

function rule(ruleId: RuleId, table: SqlName | null, object: string, message: string): RuleMatch {
  return { kind: "rule", rule: ruleId, class: RULE_CLASSES[ruleId], table, object, message };
}

function columnObject(table: SqlName, column: string): string {
  return `${table.display}.${unquoteIdentifier(column)}`;
}

function matchAddition(table: SqlName, body: string, dialect: SqlDialect): RuleMatch[] {
  const constraint = pattern(
    `^(?:CONSTRAINT\\s+${IDENT}\\s+)?(PRIMARY\\s+KEY|UNIQUE|FOREIGN\\s+KEY|CHECK|EXCLUDE|DEFAULT|PERIOD)\\b`,
  ).exec(body);
  if (/^(?:CONSTRAINT|PRIMARY|UNIQUE|FOREIGN|CHECK|EXCLUDE|DEFAULT|PERIOD)\b/i.test(body) && !constraint)
    return [];
  if (constraint) {
    const kind = (constraint[1] as string).replace(/\s+/g, " ").toUpperCase();
    if (kind === "DEFAULT" || kind === "PERIOD") return [];
    return [
      rule(
        "add-constraint",
        table,
        table.display,
        `adds a ${kind} constraint: existing rows must satisfy it, and old builds that write rows breaking it start failing`,
      ),
    ];
  }
  const column = pattern(`^(?:COLUMN\\s+)?(?:IF\\s+NOT\\s+EXISTS\\s+)?(${IDENT})\\s+(.*)$`).exec(body);
  if (!column) return [];
  const object = columnObject(table, column[1] as string);
  // Keywords inside strings or quoted names (`COLLATE "default"`, `CHECK (c <> 'NOT NULL')`) do not count.
  const definition = maskLiterals(column[2] as string, dialect);
  const isRequired = /\bNOT\s+NULL\b|\bPRIMARY\s+KEY\b/i.test(definition);
  const hasValue =
    /\bDEFAULT\b|\bIDENTITY\b|\bGENERATED\b/i.test(definition) ||
    /^(?:small|big)?serial\d?\b/i.test(definition) ||
    /^AS\s*\(/i.test(definition);
  if (isRequired && !hasValue) {
    return [
      rule(
        "add-required-column",
        table,
        object,
        `adds ${object} as NOT NULL without a default: inserts by old builds do not set it and fail`,
      ),
    ];
  }
  return [rule("add-column", table, object, `adds ${object}; old builds ignore it`)];
}

function matchColumnChange(table: SqlName, action: string, dialect: SqlDialect): RuleMatch[] {
  const alter = pattern(`^ALTER\\s+(?:COLUMN\\s+)?(${IDENT})\\s+(.*)$`).exec(action);
  if (!alter) return [];
  const object = columnObject(table, alter[1] as string);
  const change = alter[2] as string;
  if (dialect === "sqlserver") {
    if (!/^COLUMN\b/i.test(action.replace(/^ALTER\s+/i, "")) || /^(?:ADD|DROP)\b/i.test(change)) return [];
    return [
      rule(
        "alter-column",
        table,
        object,
        `redefines ${object} as "${change}": the script does not say whether the type, length or nullability changed; an old build that reads a different type or meets NOT NULL fails (accept it once reviewed as a widening)`,
      ),
    ];
  }
  if (/^(?:SET\s+DATA\s+)?TYPE\b/i.test(change)) {
    return [
      rule(
        "change-column-type",
        table,
        object,
        `changes the type of ${object}: old builds read and write the old type`,
      ),
    ];
  }
  if (/^SET\s+NOT\s+NULL\b/i.test(change)) {
    return [
      rule("set-not-null", table, object, `makes ${object} NOT NULL: old builds that leave it empty fail`),
    ];
  }
  if (/^DROP\s+NOT\s+NULL\b/i.test(change)) {
    return [
      rule(
        "drop-not-null",
        table,
        object,
        `makes ${object} nullable: once the new build writes NULL, an old build that expects a value fails after a rollback`,
      ),
    ];
  }
  if (/^DROP\s+DEFAULT\b/i.test(change)) {
    return [
      rule(
        "drop-default",
        table,
        object,
        `drops the default of ${object}: old builds that rely on it may insert NULL`,
      ),
    ];
  }
  return [];
}

function matchAlterTable(tableRaw: string, actionsText: string, dialect: SqlDialect): RuleMatch[] {
  const table = parseName(tableRaw, dialect);
  const actions = splitTopLevel(actionsText.replace(/^WITH\s+(?:NO)?CHECK\s+/i, ""), dialect);
  const matches: RuleMatch[] = [];
  // SQL Server lists several items after one verb: `ADD a int, b int` or `DROP COLUMN a, CONSTRAINT b`.
  let verb: "add" | "drop-column" | "drop-constraint" | "other" = "other";
  for (const action of actions) {
    if (/^ADD\b/i.test(action)) {
      verb = "add";
      matches.push(...matchAddition(table, action.replace(/^ADD\s+/i, ""), dialect));
    } else if (/^DROP\s+CONSTRAINT\b/i.test(action)) {
      verb = "drop-constraint";
    } else if (/^DROP\s+(?:PRIMARY|FOREIGN|INDEX|PERIOD|SYSTEM)\b/i.test(action)) {
      verb = "other";
    } else if (/^DROP\b/i.test(action)) {
      verb = "drop-column";
      matches.push(
        ...matchDropColumn(table, action.replace(/^DROP\s+(?:COLUMN\s+)?(?:IF\s+EXISTS\s+)?/i, "")),
      );
    } else if (/^ALTER\b/i.test(action)) {
      verb = "other";
      matches.push(...matchColumnChange(table, action, dialect));
    } else if (/^RENAME\s+TO\b/i.test(action)) {
      verb = "other";
      const target = action.replace(/^RENAME\s+TO\s+/i, "");
      const renamedTo = parseName(
        [...table.parts.slice(0, -1).map((part) => `"${part}"`), target].join("."),
        dialect,
      );
      matches.push({
        ...rule(
          "rename-table",
          table,
          table.display,
          `renames ${table.display} to ${unquoteIdentifier(target)}: old builds still use the old name`,
        ),
        renamedTo,
      });
    } else if (/^RENAME\s+CONSTRAINT\b/i.test(action)) {
      verb = "other";
    } else if (/^RENAME\b/i.test(action)) {
      verb = "other";
      const rename = pattern(`^RENAME\\s+(?:COLUMN\\s+)?(${IDENT})\\s+TO\\s+(${IDENT})`).exec(action);
      if (rename) {
        const object = columnObject(table, rename[1] as string);
        matches.push(
          rule(
            "rename-column",
            table,
            object,
            `renames ${object} to ${unquoteIdentifier(rename[2] as string)}: old builds still use the old name`,
          ),
        );
      }
    } else if (/^SET\s+SCHEMA\b/i.test(action)) {
      verb = "other";
      matches.push(
        rule(
          "move-table",
          table,
          table.display,
          `moves ${table.display} to another schema: old builds still use the old name`,
        ),
      );
    } else if (verb === "add") {
      matches.push(...matchAddition(table, action, dialect));
    } else if (verb === "drop-column" || verb === "drop-constraint") {
      // Each item may switch between `COLUMN` and `CONSTRAINT`; a bare item keeps the last kind.
      if (/^CONSTRAINT\b/i.test(action)) verb = "drop-constraint";
      else if (/^COLUMN\b/i.test(action)) verb = "drop-column";
      if (verb === "drop-column") {
        matches.push(...matchDropColumn(table, action.replace(/^COLUMN\s+(?:IF\s+EXISTS\s+)?/i, "")));
      }
    }
  }
  return matches;
}

function matchDropColumn(table: SqlName, rest: string): RuleMatch[] {
  const column = pattern(`^(${IDENT})`).exec(rest);
  if (!column) return [];
  const object = columnObject(table, column[1] as string);
  return [
    rule(
      "drop-column",
      table,
      object,
      `drops ${object}: old builds still read or write it and fail once it is gone; drop it in a release after the code stopped using it`,
    ),
  ];
}

function matchSpRename(match: RegExpExecArray, dialect: SqlDialect): RuleMatch[] {
  const oldName = parseName(unescapeSqlString(match[1] as string), dialect);
  const newName = unescapeSqlString(match[2] as string);
  const objectType = match[3] === undefined ? "OBJECT" : unescapeSqlString(match[3]).toUpperCase();
  if (objectType === "COLUMN") {
    const table = parseName(oldName.parts.slice(0, -1).join("."), dialect);
    const object = oldName.display;
    return [
      rule(
        "rename-column",
        table,
        object,
        `renames ${object} to ${newName}: old builds still use the old name`,
      ),
    ];
  }
  const last = oldName.parts[oldName.parts.length - 1] ?? "";
  if (objectType !== "OBJECT" || CONSTRAINT_NAME_PREFIX.test(last)) return [];
  return [
    {
      ...rule(
        "rename-table",
        oldName,
        oldName.display,
        `renames ${oldName.display} to ${newName}: old builds still use the old name`,
      ),
      renamedTo: parseName(
        [...oldName.parts.slice(0, -1), newName].map((part) => `[${part}]`).join("."),
        dialect,
      ),
    },
  ];
}

type MatchInsertOptions = { sql: string; match: RegExpExecArray; dialect: SqlDialect; context: MatchContext };

function matchInsert({ sql, match, dialect, context }: MatchInsertOptions): RuleMatch[] {
  const table = parseName(match[1] as string, dialect);
  const rest = sql.slice(match[0].length);
  const close = rest.startsWith("(") ? findClosingParen(rest, 0, dialect) : -1;
  const columns = close === -1 ? [] : splitTopLevel(rest.slice(1, close), dialect).map(unquoteIdentifier);
  const idIndex = columns.findIndex((column) => column.toLowerCase() === ID_COLUMN);
  const isIdentityInsert = context.identityInsertTables.has(table.key);
  if (idIndex === -1 && !isIdentityInsert) return [];
  const source = rest
    .slice(close + 1)
    .trim()
    .replace(/^OVERRIDING\s+(?:SYSTEM|USER)\s+VALUE\s+/i, "");
  const values = idIndex === -1 ? null : readValues(source, idIndex, dialect);
  const explicitIds: ExplicitIds = {
    column: idIndex === -1 ? null : (columns[idIndex] as string),
    rows: values === null ? null : values.length,
    range: values === null ? null : getIntegerRange(values),
  };
  return [
    {
      ...rule("insert-explicit-id", table, table.display, describeExplicitIds(table, explicitIds)),
      explicitIds,
    },
  ];
}

function getIntegerRange(values: string[]): ExplicitIds["range"] {
  if (values.length === 0) return null;
  let first = Number.POSITIVE_INFINITY;
  let last = Number.NEGATIVE_INFINITY;
  for (const value of values) {
    if (!/^-?\d+$/.test(value)) return null;
    const id = Number(value);
    if (id < first) first = id;
    if (id > last) last = id;
  }
  return { first, last };
}

/** The summary of two explicit-id inserts into the same table. */
export function mergeExplicitIds(a: ExplicitIds, b: ExplicitIds): ExplicitIds {
  return {
    column: a.column ?? b.column,
    rows: a.rows === null || b.rows === null ? null : a.rows + b.rows,
    range:
      a.range === null || b.range === null
        ? null
        : { first: Math.min(a.range.first, b.range.first), last: Math.max(a.range.last, b.range.last) },
  };
}

/** The message of an `insert-explicit-id` finding, also used when several inserts are merged into one. */
export function describeExplicitIds(table: SqlName, ids: ExplicitIds): string {
  const column = ids.column ?? "the identity column";
  if (ids.range !== null && ids.rows !== null) {
    const { first, last } = ids.range;
    const range = first === last ? `${first}` : `${first}-${last}`;
    return `inserts ${ids.rows} row(s) into ${table.display} with explicit ${column} ${range}; precondition: production max(${column}) < ${first}, and the identity sequence must continue after ${last}`;
  }
  return `inserts rows into ${table.display} with explicit ${column} values; precondition: no production row uses these values, and the identity sequence must continue after them`;
}

/** The values at `index` of every `VALUES` tuple, or `null` when the source is not a plain `VALUES` list. */
function readValues(source: string, index: number, dialect: SqlDialect): string[] | null {
  if (!/^VALUES\b/i.test(source)) return null;
  const values: string[] = [];
  for (const tuple of splitTopLevel(source.replace(/^VALUES\s*/i, ""), dialect)) {
    if (!tuple.startsWith("(")) break;
    const close = findClosingParen(tuple, 0, dialect);
    if (close === -1) break;
    const value = splitTopLevel(tuple.slice(1, close), dialect)[index];
    if (value === undefined) return null;
    values.push(value.replace(/^\((.*)\)$/s, "$1").trim());
  }
  return values;
}

function getObjectKey(kind: string, name: SqlName): string {
  return `${kind
    .replace(/\s+/g, " ")
    .toLowerCase()
    .replace(/^proc$/, "procedure")}:${name.key}`;
}

/**
 * The key of the view, function, procedure, type, sequence or schema that a `CREATE` statement
 * defines, comparable with `RuleMatch.droppedObject`; `null` for any other statement.
 */
export function getDefinedObject(sql: string, dialect: SqlDialect): string | null {
  const match = DEFINED_OBJECT.exec(sql);
  return match ? getObjectKey(match[1] as string, parseName(match[2] as string, dialect)) : null;
}

/**
 * For a T-SQL `IF <condition> <statement>`, the statement (without a wrapping `BEGIN ... END`) and
 * its offset; `null` when `sql` is not such a statement.
 */
function getTsqlIfBody(sql: string): { sql: string; offset: number } | null {
  if (!/^IF\b/i.test(sql)) return null;
  let depth = 0;
  let index = 2;
  while (index < sql.length) {
    const char = sql[index] as string;
    if (char === "'" || char === "[" || char === '"') {
      const close = char === "[" ? "]" : char;
      index += 1;
      while (index < sql.length && !(sql[index] === close && sql[index + 1] !== close)) {
        index += sql[index] === close ? 2 : 1;
      }
    } else if (char === "(") {
      depth += 1;
    } else if (char === ")") {
      depth -= 1;
    } else if (
      depth === 0 &&
      /\s/.test(sql[index - 1] ?? "") &&
      TSQL_STATEMENT_START.test(sql.slice(index))
    ) {
      const begin = /^BEGIN\b(?!\s+(?:TRAN|TRANSACTION|TRY|CATCH|DISTRIBUTED)\b)\s*/i.exec(sql.slice(index));
      if (!begin) return { sql: sql.slice(index), offset: index };
      const offset = index + begin[0].length;
      return { sql: sql.slice(offset).replace(/\bEND$/i, ""), offset };
    }
    index += 1;
  }
  return null;
}

/** The body of a `DO` block: between its first `BEGIN` and its last `END`. */
function getDoBody(body: string): { text: string; offset: number } | null {
  const begin = /\bBEGIN\b/i.exec(body);
  if (!begin) return null;
  const start = begin.index + begin[0].length;
  const ends = [...body.matchAll(/\bEND\b/gi)];
  const last = ends[ends.length - 1];
  const end = last === undefined || last.index < start ? body.length : last.index;
  return { text: body.slice(start, end), offset: start };
}

/**
 * For `WITH name AS (...)[, ...] <statement>`, the statement after the common table expressions
 * and its offset; `null` when `sql` does not start that way.
 */
function getStatementAfterCte(sql: string, dialect: SqlDialect): { sql: string; offset: number } | null {
  const head = /^WITH\s+(?:RECURSIVE\s+)?/i.exec(sql);
  if (!head) return null;
  let index = head[0].length;
  const cte = pattern(`^${IDENT}\\s*(?:\\([^)]*\\)\\s*)?AS\\s*(?:NOT\\s+)?(?:MATERIALIZED\\s+)?\\(`);
  for (;;) {
    const start = cte.exec(sql.slice(index));
    if (!start) return null;
    const close = findClosingParen(sql, index + start[0].length - 1, dialect);
    if (close === -1) return null;
    const after = /^\s*(,)?\s*/.exec(sql.slice(close + 1)) as RegExpExecArray;
    index = close + 1 + after[0].length;
    if (after[1] === undefined) return { sql: sql.slice(index), offset: index };
  }
}

/**
 * Procedural wrappers whose inner statement is matched again: a T-SQL `IF <condition>`, `ELSE`,
 * `BEGIN <statement>`; in PL/pgSQL `IF ... THEN`, `ELSIF ... THEN`, `ELSE` and `BEGIN <statement>`.
 */
function getWrappedStatement(sql: string, dialect: SqlDialect): { sql: string; offset: number } | null {
  if (dialect === "sqlserver") {
    const body = getTsqlIfBody(sql);
    if (body !== null) return body;
  } else {
    const opener = /^(?:IF|ELSIF|ELSEIF)\b.*?\bTHEN\b\s*/is.exec(sql);
    if (opener) return { sql: sql.slice(opener[0].length), offset: opener[0].length };
  }
  const wrapper =
    /^(?:ELSE|BEGIN(?!\s+(?:TRAN|TRANSACTION|TRY|CATCH|DISTRIBUTED|WORK|ISOLATION)\b))\s+(?=\S)/i.exec(sql);
  return wrapper ? { sql: sql.slice(wrapper[0].length), offset: wrapper[0].length } : null;
}

/**
 * Matches one statement (comment-masked, without its `;`) against the rule set. Returns zero or
 * more matches; an unrecognised statement returns none.
 */
export function matchStatement(sql: string, dialect: SqlDialect, context: MatchContext): StatementMatch[] {
  const identityInsert = IDENTITY_INSERT.exec(sql);
  if (identityInsert) {
    const table = parseName(identityInsert[1] as string, dialect);
    return [
      { kind: "identity-insert", table, isEnabled: (identityInsert[2] as string).toUpperCase() === "ON" },
    ];
  }
  // A PL/pgSQL exception handler (`EXCEPTION WHEN ... THEN`) only runs when the block failed.
  if (dialect === "postgres" && /^EXCEPTION\b/i.test(sql)) return [];
  const wrapped = getWrappedStatement(sql, dialect) ?? getStatementAfterCte(sql, dialect);
  if (wrapped !== null) return [{ kind: "nested", ...wrapped }];
  const exec = EXEC_LITERAL.exec(sql);
  if (exec) return [{ kind: "nested", sql: unescapeSqlString(exec[1] as string), offset: null }];
  if (dialect === "postgres") {
    const doBlock = DO_BLOCK.exec(sql);
    if (doBlock) {
      const tagLength = (doBlock[1] as string).length;
      const bodyStart = sql.indexOf(doBlock[1] as string) + tagLength;
      const body = getDoBody(doBlock[2] as string);
      return body ? [{ kind: "nested", sql: body.text, offset: bodyStart + body.offset }] : [];
    }
  }

  const schema = CREATE_SCHEMA.exec(sql);
  if (schema) {
    const name = unquoteIdentifier(schema[1] as string);
    return [rule("create-schema", null, name, `creates schema ${name}; old builds do not use it`)];
  }
  const table = CREATE_TABLE.exec(sql);
  if (table) {
    const name = parseName(table[1] as string, dialect);
    const ifNotExists = /^CREATE\s.*?\bTABLE\s+IF\s+NOT\s+EXISTS\b/is.test(sql);
    return [
      {
        ...rule(
          "create-table",
          name,
          name.display,
          `creates table ${name.display}; old builds do not use it`,
        ),
        ifNotExists,
      },
    ];
  }
  const index = CREATE_INDEX.exec(sql);
  if (index) {
    const name = parseName(index[2] as string, dialect);
    return index[1]
      ? [
          rule(
            "add-unique-index",
            name,
            name.display,
            `adds a unique index on ${name.display}: existing rows must be unique, and old builds that write duplicates start failing`,
          ),
        ]
      : [rule("create-index", name, name.display, `adds an index on ${name.display}`)];
  }
  const dropTable = DROP_TABLE.exec(sql);
  if (dropTable) {
    return [...(dropTable[1] as string).matchAll(new RegExp(NAME, "g"))].map((nameMatch) => {
      const name = parseName(nameMatch[0], dialect);
      return rule("drop-table", name, name.display, `drops table ${name.display}: old builds still use it`);
    });
  }
  const dropObject = DROP_OBJECT.exec(sql);
  if (dropObject) {
    const kind = (dropObject[1] as string).replace(/\s+/g, " ").toLowerCase();
    const name = parseName(dropObject[2] as string, dialect);
    return [
      {
        ...rule(
          "drop-object",
          null,
          name.display,
          `drops ${kind} ${name.display}: old builds may still use it`,
        ),
        droppedObject: getObjectKey(kind, name),
      },
    ];
  }
  const alterTable = ALTER_TABLE.exec(sql);
  if (alterTable) return matchAlterTable(alterTable[1] as string, alterTable[2] as string, dialect);
  const alterType = ALTER_TYPE.exec(sql);
  if (alterType && dialect === "postgres") {
    const name = parseName(alterType[1] as string, dialect);
    return (alterType[2] as string).toUpperCase() === "ADD"
      ? [
          rule(
            "enum-value-added",
            null,
            name.display,
            `adds a value to enum ${name.display}: once a row holds it, an old build that maps the enum fails to read it after a rollback`,
          ),
        ]
      : [
          rule(
            "enum-value-renamed",
            null,
            name.display,
            `renames a value of enum ${name.display}: old builds still use the old value`,
          ),
        ];
  }
  const transfer = SCHEMA_TRANSFER.exec(sql);
  if (transfer) {
    const name = parseName(transfer[1] as string, dialect);
    return [
      rule(
        "move-table",
        name,
        name.display,
        `moves ${name.display} to another schema: old builds still use the old name`,
      ),
    ];
  }
  const spRename = SP_RENAME.exec(sql);
  if (spRename) return matchSpRename(spRename, dialect);
  const truncate = TRUNCATE.exec(sql);
  if (truncate) {
    const name = parseName(truncate[1] as string, dialect);
    return [
      rule(
        "truncate",
        name,
        name.display,
        `deletes every row of ${name.display}; old builds lose the data they rely on`,
      ),
    ];
  }
  const update = UPDATE.exec(sql);
  if (update) {
    const name = parseName(update[1] as string, dialect);
    return [
      rule(
        "update-data",
        name,
        name.display,
        `updates existing rows of ${name.display}: old builds keep running on the changed data, and a rollback does not undo it`,
      ),
    ];
  }
  const remove = DELETE.exec(sql);
  if (remove) {
    const name = parseName(remove[1] as string, dialect);
    return [
      rule(
        "delete-data",
        name,
        name.display,
        `deletes rows of ${name.display}: old builds may still need them, and a rollback does not restore them`,
      ),
    ];
  }
  const merge = MERGE.exec(sql);
  if (merge) {
    const name = parseName(merge[1] as string, dialect);
    return [
      rule(
        "merge-data",
        name,
        name.display,
        `merges data into ${name.display}: existing rows may change, and a rollback does not undo it`,
      ),
    ];
  }
  const insert = INSERT.exec(sql);
  if (insert) return matchInsert({ sql, match: insert, dialect, context });
  return [];
}
