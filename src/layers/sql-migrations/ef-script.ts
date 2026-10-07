import { err, ok, type Result } from "../../result.js";
import {
  createLineIndex,
  maskComments,
  type SqlDialect,
  type SqlStatement,
  splitStatements,
} from "../../sql/statements.js";

export type EfMigration = { id: string; statements: SqlStatement[] };

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * The `IF NOT EXISTS (SELECT ... FROM <history> WHERE <MigrationId> = '<id>')` guard that EF Core
 * writes before every block of an idempotent script, on one line (EF 6) or several (EF 7+),
 * followed by `THEN` (Npgsql) or `BEGIN` (SqlServer).
 */
function createGuardPattern(dialect: SqlDialect, historyTable: string): RegExp {
  const quote = `["\\[\\]]?`;
  const table = `(?:${quote}\\w+${quote}\\s*\\.\\s*)?${quote}${escapeRegExp(historyTable)}${quote}`;
  const opener = dialect === "postgres" ? "THEN" : "BEGIN";
  return new RegExp(
    `IF\\s+NOT\\s+EXISTS\\s*\\(\\s*SELECT\\s+(?:1|\\*)\\s+FROM\\s+${table}\\s+WHERE\\s+${quote}MigrationId${quote}\\s*=\\s*N?'([^']*)'\\s*\\)\\s*${opener}\\b`,
    "gi",
  );
}

/** Where a guarded block ends: the last `END IF` (Npgsql) or `END` (SqlServer) before the next guard. */
function findBlockEnd(masked: string, start: number, limit: number, dialect: SqlDialect): number {
  const terminator = dialect === "postgres" ? /\bEND\s+IF\b/gi : /\bEND\b/gi;
  let end = -1;
  for (const match of masked.slice(start, limit).matchAll(terminator)) end = start + match.index;
  return end === -1 ? limit : end;
}

/**
 * Splits an EF Core idempotent script into its migrations: every block guarded by the same
 * migration id belongs to that migration, in script order. Statements that touch the history
 * table are EF bookkeeping and are left out; so is everything outside a guard.
 */
export function parseEfScript(
  text: string,
  dialect: SqlDialect,
  historyTable: string,
): Result<EfMigration[]> {
  if (text.trim() === "") return ok([]);
  const masked = maskComments(text, dialect);
  const guards = [...masked.matchAll(createGuardPattern(dialect, historyTable))];
  if (guards.length === 0) {
    return err(
      `no EF Core migration guard found (IF NOT EXISTS ... FROM ${historyTable} WHERE MigrationId = '...'); is this a script from 'dotnet ef migrations script --idempotent' for ${dialect}?`,
    );
  }
  const historyMention = new RegExp(`\\b${escapeRegExp(historyTable)}\\b`, "i");
  const lineAt = createLineIndex(text);
  const migrations = new Map<string, SqlStatement[]>();
  guards.forEach((guard, index) => {
    const id = guard[1] as string;
    const bodyStart = guard.index + guard[0].length;
    const limit = guards[index + 1]?.index ?? masked.length;
    const bodyEnd = findBlockEnd(masked, bodyStart, limit, dialect);
    const firstLine = lineAt(bodyStart);
    const statements = splitStatements(masked.slice(bodyStart, bodyEnd), dialect)
      .filter((statement) => !historyMention.test(statement.sql))
      .map((statement) => ({
        ...statement,
        line: firstLine + statement.line - 1,
        offset: bodyStart + statement.offset,
      }));
    migrations.set(id, [...(migrations.get(id) ?? []), ...statements]);
  });
  return ok([...migrations].map(([id, statements]) => ({ id, statements })));
}
