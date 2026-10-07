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

type FindBlockEndOptions = { masked: string; start: number; limit: number; dialect: SqlDialect };

/** Where a guarded block ends: the last `END IF` (Npgsql) or `END` (SqlServer) before the next guard. */
function findBlockEnd({ masked, start, limit, dialect }: FindBlockEndOptions): number {
  const terminator = dialect === "postgres" ? /\bEND\s+IF\b/gi : /\bEND\b/gi;
  let end = -1;
  for (const match of masked.slice(start, limit).matchAll(terminator)) end = start + match.index;
  return end === -1 ? limit : end;
}

export type EfScript = {
  /** Guarded blocks gathered per migration id, in script order. */
  migrations: EfMigration[];
  /** Statements outside every guard that are not EF bookkeeping (hand-written or appended SQL). */
  unguarded: SqlStatement[];
};

/** Transaction control and block ends that EF writes between guards. */
const BOOKKEEPING =
  /^(?:START\s+TRANSACTION|BEGIN(?:\s+(?:TRAN|TRANSACTION|WORK))?|COMMIT|ROLLBACK|END(?:\s+\$\w*\$)?)(?:\s+(?:TRAN|TRANSACTION|WORK))?$/i;

/**
 * Splits an EF Core idempotent script into its migrations: every block guarded by the same
 * migration id belongs to that migration, in script order. Statements that touch the history
 * table and transaction control are EF bookkeeping and are left out; any other statement outside
 * a guard is returned as `unguarded`.
 */
export function parseEfScript(text: string, dialect: SqlDialect, historyTable: string): Result<EfScript> {
  if (text.trim() === "") return ok({ migrations: [], unguarded: [] });
  const masked = maskComments(text, dialect);
  const guardPattern = createGuardPattern(dialect, historyTable);
  const guards = [...masked.matchAll(guardPattern)];
  if (guards.length === 0) {
    return err(
      `no EF Core migration guard found (IF NOT EXISTS ... FROM ${historyTable} WHERE MigrationId = '...'); is this a script from 'dotnet ef migrations script --idempotent' for ${dialect}?`,
    );
  }
  const historyMention = new RegExp(`\\b${escapeRegExp(historyTable)}\\b`, "i");
  const isBookkeeping = (statement: SqlStatement) =>
    historyMention.test(statement.sql) || BOOKKEEPING.test(statement.sql);
  const lineAt = createLineIndex(text);
  const splitRegion = (start: number, end: number): SqlStatement[] => {
    const firstLine = lineAt(start);
    return splitStatements(masked.slice(start, end), dialect).map((statement) => ({
      ...statement,
      line: firstLine + statement.line - 1,
      offset: start + statement.offset,
    }));
  };
  const migrations = new Map<string, SqlStatement[]>();
  const gaps: [number, number][] = [];
  let gapStart = 0;
  guards.forEach((guard, index) => {
    const id = guard[1] as string;
    const bodyStart = guard.index + guard[0].length;
    const limit = guards[index + 1]?.index ?? masked.length;
    const bodyEnd = findBlockEnd({ masked, start: bodyStart, limit, dialect });
    const statements = splitRegion(bodyStart, bodyEnd).filter((statement) => !isBookkeeping(statement));
    migrations.set(id, [...(migrations.get(id) ?? []), ...statements]);
    gaps.push([gapStart, guard.index]);
    gapStart = bodyEnd;
  });
  gaps.push([gapStart, masked.length]);
  return ok({
    migrations: [...migrations].map(([id, statements]) => ({ id, statements })),
    unguarded: findUnguarded({ masked, dialect, gaps, guardPattern, splitRegion }).filter(
      (statement) => !isBookkeeping(statement),
    ),
  });
}

type FindUnguardedOptions = {
  masked: string;
  dialect: SqlDialect;
  gaps: [number, number][];
  guardPattern: RegExp;
  splitRegion(start: number, end: number): SqlStatement[];
};

/**
 * Statements outside the guards. Npgsql guards sit inside `DO $EF$` bodies, whose dollar quotes a
 * gap would cut in half, so there every top-level statement without a guard counts; SqlServer
 * guards are top-level, so the gaps between blocks are split directly.
 */
function findUnguarded({
  masked,
  dialect,
  gaps,
  guardPattern,
  splitRegion,
}: FindUnguardedOptions): SqlStatement[] {
  if (dialect === "postgres") {
    const guard = new RegExp(guardPattern.source, "i");
    return splitRegion(0, masked.length).filter((statement) => !guard.test(statement.sql));
  }
  return gaps.flatMap(([start, end]) => splitRegion(start, end));
}
