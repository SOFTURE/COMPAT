import type { RefTree } from "../../git/ref-tree.js";
import type { Finding } from "../../model/finding.js";
import type { SqlName } from "../../sql/identifiers.js";
import { type SqlDialect, type SqlStatement, splitStatements } from "../../sql/statements.js";
import {
  describeExplicitIds,
  type ExplicitIds,
  getDefinedObject,
  matchStatement,
  mergeExplicitIds,
  RULE_CLASSES,
  type RuleMatch,
} from "./rules.js";

export const SQL_MIGRATIONS_LAYER = "sql-migrations";

/** Nested SQL (a `DO` body, an `EXEC` literal) is unwrapped at most this deep. */
const MAX_NESTING = 3;

export type Migration = {
  /** Migration id: the EF migration id, or the path relative to the folder source. */
  id: string;
  /** Repository-relative path of the file that holds the statements. */
  path: string;
  /** Statements with lines relative to `path`. */
  statements: SqlStatement[];
};

export type ClassifiedFinding = { finding: Finding; migration: string; object: string };

export type AcceptEntry = { id: string; migration: string; object?: string | undefined; reason: string };

export type ClassifyOptions = {
  sourceName: string;
  dialect: SqlDialect;
  /** New migrations of the revision, in the order they run. */
  migrations: Migration[];
  /** Keys of tables that the base's migrations of the same source create. */
  baseTables: ReadonlySet<string>;
  revision: Pick<RefTree, "side" | "ref" | "commit">;
};

type LocatedMatch = { match: RuleMatch; line: number; order: number };

/** Statement positions across all new migrations of a source, and where each object is defined. */
type Walk = { order: number; definedAt: Map<string, number> };

/** Matches every statement of one migration in order, unwrapping nested SQL. */
function matchMigration(migration: Migration, dialect: SqlDialect, walk: Walk): LocatedMatch[] {
  const identityInsertTables = new Set<string>();
  const located: LocatedMatch[] = [];
  const visit = (statement: SqlStatement, line: number, depth: number): void => {
    walk.order += 1;
    const defined = getDefinedObject(statement.sql, dialect);
    if (defined !== null) walk.definedAt.set(defined, walk.order);
    for (const match of matchStatement(statement.sql, dialect, { identityInsertTables })) {
      if (match.kind === "identity-insert") {
        if (match.isEnabled) identityInsertTables.add(match.table.key);
        else identityInsertTables.delete(match.table.key);
      } else if (match.kind === "rule") {
        located.push({ match, line, order: walk.order });
      } else if (depth < MAX_NESTING) {
        const nestedLine =
          match.offset === null ? null : line + countNewlines(statement.sql.slice(0, match.offset));
        for (const inner of splitStatements(match.sql, dialect)) {
          visit(inner, nestedLine === null ? line : nestedLine + inner.line - 1, depth + 1);
        }
      }
    }
  };
  for (const statement of migration.statements) visit(statement, statement.line, 0);
  return located;
}

function countNewlines(text: string): number {
  let count = 0;
  for (const char of text) if (char === "\n") count += 1;
  return count;
}

/** Keys of the tables that `CREATE TABLE` statements of these migrations name. */
export function getCreatedTables(migrations: Migration[], dialect: SqlDialect): Set<string> {
  const tables = new Set<string>();
  const walk: Walk = { order: 0, definedAt: new Map() };
  for (const migration of migrations) {
    for (const { match } of matchMigration(migration, dialect, walk)) {
      if (match.rule === "create-table" && match.table) tables.add(match.table.key);
    }
  }
  return tables;
}

/** Rules that describe the creation itself; they are never downgraded. */
const ADDITIVE_RULES = new Set(["create-schema", "create-table", "create-index", "add-column"]);

type MergedInsert = { item: ClassifiedFinding; table: SqlName; ids: ExplicitIds; isNewTable: boolean };

/**
 * Turns the statements of the new migrations into findings: tables created by these migrations
 * make later findings on them `safe`, a dropped object that a later statement creates again is a
 * redefinition, and explicit-id inserts are merged per migration and table.
 */
export function classifyMigrations(options: ClassifyOptions): ClassifiedFinding[] {
  const walk: Walk = { order: 0, definedAt: new Map() };
  const matched = options.migrations.map((migration) => ({
    migration,
    matches: matchMigration(migration, options.dialect, walk),
  }));
  const touched = new Set<string>();
  const created = new Set<string>();
  const classified: ClassifiedFinding[] = [];
  const merged = new Map<string, MergedInsert>();

  for (const { migration, matches } of matched) {
    for (const { match, line, order } of matches) {
      const tableKey = match.table?.key ?? null;
      const isNewTable = tableKey !== null && created.has(tableKey) && !ADDITIVE_RULES.has(match.rule);
      if (match.rule === "create-table" && tableKey !== null) {
        const mayExist = match.ifNotExists === true && options.baseTables.has(tableKey);
        if (!touched.has(tableKey) && !mayExist) created.add(tableKey);
      }
      if (match.rule === "rename-table" && match.renamedTo && tableKey !== null && created.has(tableKey)) {
        created.add(match.renamedTo.key);
      }
      if (tableKey !== null) touched.add(tableKey);
      if (match.renamedTo) touched.add(match.renamedTo.key);

      const isRedefined =
        match.droppedObject !== undefined && (walk.definedAt.get(match.droppedObject) ?? 0) > order;
      const finding = buildFinding({ options, migration, match, line, isNewTable, isRedefined });
      const item = { finding, migration: migration.id, object: match.object };
      if (match.explicitIds && match.table) {
        const key = `${migration.id}\0${match.table.key}`;
        const earlier = merged.get(key);
        if (earlier) {
          earlier.ids = mergeExplicitIds(earlier.ids, match.explicitIds);
          continue;
        }
        merged.set(key, { item, table: match.table, ids: match.explicitIds, isNewTable });
      }
      classified.push(item);
    }
  }
  for (const { item, table, ids, isNewTable } of merged.values()) {
    item.finding.message = describeMessage(describeExplicitIds(table, ids), isNewTable);
  }
  return classified;
}

function describeMessage(message: string, isNewTable: boolean): string {
  return isNewTable ? `on a table created by these migrations, so no old build uses it: ${message}` : message;
}

type BuildFindingOptions = {
  options: ClassifyOptions;
  migration: Migration;
  match: RuleMatch;
  line: number;
  isNewTable: boolean;
  isRedefined: boolean;
};

function buildFinding({
  options,
  migration,
  match,
  line,
  isNewTable,
  isRedefined,
}: BuildFindingOptions): Finding {
  const id = isRedefined ? "object-redefined" : match.rule;
  const message = isRedefined
    ? `drops and creates ${match.object} again: old builds get the new definition; check that it still gives them what they expect`
    : describeMessage(match.message, isNewTable);
  return {
    layer: SQL_MIGRATIONS_LAYER,
    scope: options.sourceName,
    id,
    subject: `${migration.id}: ${match.object}`,
    class: isNewTable ? "safe" : RULE_CLASSES[id],
    message,
    evidence: [
      {
        side: options.revision.side,
        ref: options.revision.ref,
        commit: options.revision.commit,
        path: migration.path,
        line,
      },
    ],
  };
}

/**
 * Marks findings matched by an accept entry (rule id, migration id and, when given, the object,
 * case-insensitively). An accepted finding keeps its class and does not count for the gate.
 */
export function applyAccept(
  classified: ClassifiedFinding[],
  accept: AcceptEntry[],
): { findings: Finding[]; usage: { entry: AcceptEntry; count: number }[] } {
  const usage = accept.map((entry) => ({ entry, count: 0 }));
  const findings = classified.map(({ finding, migration, object }) => {
    const used = usage.find(
      ({ entry }) =>
        entry.id === finding.id &&
        entry.migration === migration &&
        (entry.object === undefined || entry.object.toLowerCase() === object.toLowerCase()),
    );
    if (!used) return finding;
    used.count += 1;
    return { ...finding, accepted: { reason: used.entry.reason } };
  });
  return { findings, usage };
}
