import type { SqlDialect } from "./statements.js";

/** One identifier: `"x"`, `[x]`, `` `x` `` or a bare name. A regular-expression source without groups. */
export const IDENTIFIER_PATTERN = '(?:"(?:[^"]|"")+"|\\[(?:[^\\]]|\\]\\])+\\]|`[^`]+`|[A-Za-z_#@][\\w$#@]*)';

/** A possibly qualified name (`table`, `schema.table`, `db.schema.table`). A regular-expression source without groups. */
export const NAME_PATTERN = `${IDENTIFIER_PATTERN}(?:\\s*\\.\\s*${IDENTIFIER_PATTERN}){0,2}`;

const DEFAULT_SCHEMA: Record<SqlDialect, string> = { postgres: "public", sqlserver: "dbo" };

export type SqlName = {
  /** Unquoted parts as written. */
  parts: string[];
  /** Unquoted parts joined with `.`, as written. */
  display: string;
  /** Lowercase `schema.object` with the dialect's default schema filled in; equal keys name the same object. */
  key: string;
};

export function unquoteIdentifier(raw: string): string {
  const trimmed = raw.trim();
  const open = trimmed[0];
  const close = trimmed[trimmed.length - 1];
  if (open === '"' && close === '"') return trimmed.slice(1, -1).replace(/""/g, '"');
  if (open === "[" && close === "]") return trimmed.slice(1, -1).replace(/\]\]/g, "]");
  if (open === "`" && close === "`") return trimmed.slice(1, -1);
  return trimmed;
}

export function parseName(raw: string, dialect: SqlDialect): SqlName {
  const parts = [...raw.matchAll(new RegExp(IDENTIFIER_PATTERN, "g"))].map((match) =>
    unquoteIdentifier(match[0]),
  );
  const objectParts = parts.slice(-2);
  const qualified = objectParts.length === 1 ? [DEFAULT_SCHEMA[dialect], ...objectParts] : objectParts;
  return { parts, display: parts.join("."), key: qualified.join(".").toLowerCase() };
}

/** The value of a SQL string literal: `N'it''s'` → `it's`. */
export function unescapeSqlString(literal: string): string {
  const body = literal
    .trim()
    .replace(/^[NnEe]?'/, "")
    .replace(/'$/, "");
  return body.replace(/''/g, "'");
}
