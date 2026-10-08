import type { RefTree } from "../../git/ref-tree.js";
import type { Finding } from "../../model/finding.js";
import type { SqlName } from "../../sql/identifiers.js";
import { type SqlDialect, type SqlStatement, splitStatements } from "../../sql/statements.js";
import {
  describeExplicitIds,
  type ExplicitIds,
  getDefinedObject,
  isSequenceMovedPast,
  matchStatement,
  mergeExplicitIds,
  RULE_CLASSES,
  type RuleId,
  type RuleMatch,
  type SequenceReset,
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

export type ClassifiedFinding = {
  finding: Finding;
  migration: string;
  object: string;
  /** `insert-explicit-id` on a table that already exists: what the preconditions command can settle. */
  explicitIds?: { table: SqlName; ids: ExplicitIds; isSequenceMoved: boolean };
  /** `insert-explicit-id` only: whether the base alone shows that only migrations wrote the table. */
  basis?: Basis;
};

/** Whether the `migrations-only` basis holds for an explicit-id insert, and why not when it does not. */
export type Basis = { holds: true } | { holds: false; reason: string };

/** What an accept entry may require besides the rule, migration and object. */
export const ACCEPT_BASES = ["migrations-only"] as const;

export type AcceptEntry = {
  id: string;
  migration: string;
  object?: string | undefined;
  /** `migrations-only`: the entry matches only while the finding's `basis` holds. */
  basis?: (typeof ACCEPT_BASES)[number] | undefined;
  reason: string;
};

/** A position in a base migration script. */
export type ScriptLine = { path: string; line: number };

/** What the base's migrations wrote into one table with explicit ids. */
export type BaseExplicitIds = {
  /** The highest integer id inserted explicitly, and where; `null` when no insert has integer literal ids. */
  max: (ScriptLine & { id: number }) | null;
  /** Whether some explicit-id insert has ids that cannot be read (`INSERT ... SELECT`, expressions). */
  hasUnreadIds: boolean;
  /** The first statement that moves the table's identity sequence, or `null` when none does. */
  sequenceReset: ScriptLine | null;
};

export type ClassifyOptions = {
  sourceName: string;
  dialect: SqlDialect;
  /** New migrations of the revision, in the order they run. */
  migrations: Migration[];
  /** Keys of tables that the base's migrations of the same source create. */
  baseTables: ReadonlySet<string>;
  revision: Pick<RefTree, "side" | "ref" | "commit">;
};

type LocatedMatch = { match: RuleMatch | SequenceReset; line: number; order: number };

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
      } else if (match.kind === "rule" || match.kind === "sequence-reset") {
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
      if (match.kind === "rule" && match.rule === "create-table" && match.table) tables.add(match.table.key);
    }
  }
  return tables;
}

/**
 * Per table key, the explicit ids the base's migrations insert and whether they move the identity
 * sequence; a table with neither is absent.
 */
export function getBaseExplicitIds(
  migrations: Migration[],
  dialect: SqlDialect,
): Map<string, BaseExplicitIds> {
  const tables = new Map<string, BaseExplicitIds>();
  const getTable = (key: string): BaseExplicitIds => {
    const existing = tables.get(key);
    if (existing) return existing;
    const created: BaseExplicitIds = { max: null, hasUnreadIds: false, sequenceReset: null };
    tables.set(key, created);
    return created;
  };
  const walk: Walk = { order: 0, definedAt: new Map() };
  for (const migration of migrations) {
    for (const { match, line } of matchMigration(migration, dialect, walk)) {
      if (match.kind === "sequence-reset") {
        const table = getTable(match.table.key);
        table.sequenceReset ??= { path: migration.path, line };
        continue;
      }
      if (match.explicitIds === undefined || match.table === null) continue;
      const table = getTable(match.table.key);
      const range = match.explicitIds.range;
      if (range === null) table.hasUnreadIds = true;
      else if (table.max === null || range.last > table.max.id) {
        table.max = { id: range.last, path: migration.path, line };
      }
    }
  }
  return tables;
}

/** Rules that describe the creation itself; they are never downgraded. */
const ADDITIVE_RULE_IDS = ["create-schema", "create-table", "create-index", "add-column"] as const;
type AdditiveRuleId = (typeof ADDITIVE_RULE_IDS)[number];
const ADDITIVE_RULES: ReadonlySet<RuleId> = new Set(ADDITIVE_RULE_IDS);

/**
 * What a statement does, without its risk, for findings on a table created by the same migrations:
 * no old build uses that table, so the risk text of the rule does not apply.
 */
const NEW_TABLE_ACTIONS: Record<Exclude<RuleId, AdditiveRuleId>, string> = {
  "add-required-column": "adds required column",
  "add-unique-index": "adds a unique index on",
  "add-constraint": "adds a constraint on",
  "drop-table": "drops table",
  "drop-column": "drops column",
  "drop-object": "drops",
  "rename-table": "renames table",
  "rename-column": "renames column",
  "move-table": "moves table",
  "change-column-type": "changes the type of",
  "alter-column": "alters column",
  "set-not-null": "sets NOT NULL on",
  "drop-not-null": "drops NOT NULL on",
  "drop-default": "drops the default of",
  "enum-value-added": "adds an enum value to",
  "enum-value-renamed": "renames an enum value of",
  truncate: "truncates",
  "update-data": "updates rows in",
  "delete-data": "deletes rows from",
  "merge-data": "merges rows into",
  "insert-explicit-id": "inserts rows with explicit ids into",
  "object-redefined": "drops and creates again",
};

type MergedInsert = {
  item: ClassifiedFinding;
  table: SqlName;
  ids: ExplicitIds;
  isNewTable: boolean;
  /** Position of the last insert, so only a sequence reset after it counts. */
  lastOrder: number;
  resets: LocatedSequenceReset[];
};

type LocatedSequenceReset = { reset: SequenceReset; line: number; order: number };

/**
 * Turns the statements of the new migrations into findings: tables created by these migrations
 * make later findings on them `safe`, a dropped object that a later statement creates again is a
 * redefinition, and explicit-id inserts are merged per migration and table. A sequence reset on the
 * table later in the same migration drops the sequence half of their precondition.
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
    const resets: LocatedSequenceReset[] = [];
    for (const { match, line, order } of matches) {
      if (match.kind === "sequence-reset") {
        resets.push({ reset: match, line, order });
        continue;
      }
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
          earlier.lastOrder = order;
          continue;
        }
        merged.set(key, {
          item,
          table: match.table,
          ids: match.explicitIds,
          isNewTable,
          lastOrder: order,
          resets,
        });
      }
      classified.push(item);
    }
  }
  for (const insert of merged.values()) {
    if (insert.isNewTable) continue;
    const moved = findSequenceMove(insert);
    insert.item.finding.message = describeExplicitIds(insert.table, insert.ids, moved !== undefined);
    insert.item.explicitIds = { table: insert.table, ids: insert.ids, isSequenceMoved: moved !== undefined };
    const evidence = insert.item.finding.evidence[0];
    if (moved !== undefined && evidence) insert.item.finding.evidence.push({ ...evidence, line: moved.line });
  }
  return classified;
}

/** The first reset of the inserted table's identity sequence after its last insert that moves it past the ids. */
function findSequenceMove({ table, ids, lastOrder, resets }: MergedInsert): LocatedSequenceReset | undefined {
  return resets.find(
    ({ reset, order }) =>
      order > lastOrder &&
      reset.table.key === table.key &&
      (reset.column === null ||
        ids.column === null ||
        reset.column.toLowerCase() === ids.column.toLowerCase()) &&
      isSequenceMovedPast(reset.next, ids),
  );
}

function describeNewTableFinding(ruleId: Exclude<RuleId, AdditiveRuleId>, object: string): string {
  return `${NEW_TABLE_ACTIONS[ruleId]} ${object}; the table is created by these migrations, so no old build uses it`;
}

function isAdditiveRule(ruleId: RuleId): ruleId is AdditiveRuleId {
  return ADDITIVE_RULES.has(ruleId);
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
  const message = getFindingMessage(id, match, isNewTable);
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

function getFindingMessage(id: RuleId, match: RuleMatch, isNewTable: boolean): string {
  if (isNewTable && !isAdditiveRule(id)) return describeNewTableFinding(id, match.object);
  if (id === "object-redefined") {
    return `drops and creates ${match.object} again: old builds get the new definition; check that it still gives them what they expect`;
  }
  return match.message;
}

/**
 * Marks findings matched by an accept entry (rule id, migration id and, when given, the object,
 * case-insensitively). An accepted finding keeps its class and does not count for the gate.
 */
export function applyAccept(
  classified: ClassifiedFinding[],
  accept: AcceptEntry[],
): { findings: Finding[]; usage: AcceptUsage[] } {
  const usage: AcceptUsage[] = accept.map((entry) => ({ entry, count: 0, refusals: [] }));
  const findings = classified.map((item) => {
    const { finding, migration, object } = item;
    const candidates = usage.filter(
      ({ entry }) =>
        entry.id === finding.id &&
        entry.migration === migration &&
        (entry.object === undefined || entry.object.toLowerCase() === object.toLowerCase()),
    );
    const used = candidates.find((candidate) => {
      const refusal = getBasisRefusal(candidate.entry, item);
      if (refusal !== null) candidate.refusals.push(refusal);
      return refusal === null;
    });
    if (!used) return finding;
    used.count += 1;
    return { ...finding, accepted: { reason: used.entry.reason } };
  });
  return { findings, usage };
}

/** How many findings an accept entry accepted, and why it refused findings it named when its basis failed. */
export type AcceptUsage = { entry: AcceptEntry; count: number; refusals: string[] };

/** Why an entry's basis does not hold for the finding, or `null` when the entry has none or it holds. */
function getBasisRefusal(entry: AcceptEntry, item: ClassifiedFinding): string | null {
  if (entry.basis === undefined) return null;
  if (item.finding.class === "breaking") return "the finding is breaking";
  if (item.basis === undefined) return "the finding carries no migrations-only evidence";
  return item.basis.holds ? null : item.basis.reason;
}
