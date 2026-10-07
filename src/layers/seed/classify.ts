import type { RefTree } from "../../git/ref-tree.js";
import type { Evidence, Finding, FindingClass } from "../../model/finding.js";
import type { SqlName } from "../../sql/identifiers.js";
import type { ConflictMode, SeedRow, SeedStatement } from "./seed-statements.js";

export const SEED_LAYER = "seed";

export const SEED_RULE_CLASSES = {
  "row-added": "safe",
  "row-removed": "safe",
  "seed-file-removed": "safe",
  "insert-query-added": "safe",
  "row-changed": "needs-action",
  "row-change-ignored": "needs-action",
  "row-added-skipped": "needs-action",
  "row-deleted": "needs-action",
  "unreadable-write": "needs-action",
  "insert-unguarded": "needs-action",
  "upsert-query": "needs-action",
  "update-data": "needs-action",
  "delete-data": "needs-action",
  truncate: "needs-action",
} as const satisfies Record<string, FindingClass>;

export type SeedRuleId = keyof typeof SEED_RULE_CLASSES;

/** Keys and evidence lines listed in one finding at most. */
const MAX_LISTED = 5;

export type ClassifiedFinding = { finding: Finding; object: string };

export type SeedAcceptEntry = { id: string; object?: string | undefined; reason: string };

type TreeRef = Pick<RefTree, "side" | "ref" | "commit">;

export type SeedFile = {
  /** Repository-relative path of the seed file. */
  path: string;
  /** Statements of the file at the base; `null` when the file is new in the revision. */
  base: SeedStatement[] | null;
  /** Statements of the file at the revision; `null` when the revision removed the file. */
  revision: SeedStatement[] | null;
};

export type ClassifySeedSourceOptions = {
  sourceName: string;
  /** Every seed file of the source at either ref. */
  files: SeedFile[];
  baseTree: TreeRef;
  revisionTree: TreeRef;
};

/** A statement with the path of the file it was read from. */
type Located = SeedStatement & { path: string };
type RowsStatement = Extract<Located, { kind: "rows" }>;
type OtherStatement = Exclude<Located, RowsStatement>;

type KeyedRow = SeedRow & {
  path: string;
  columns: string;
  mode: ConflictMode;
  guard: string | null;
  action: string;
};

type TableRows = {
  table: SqlName;
  keyColumns: string[];
  rows: KeyedRow[];
  /** A `MERGE` of this table deletes rows missing from its source. */
  deletesMissing: boolean;
  /** Two rows share a key (the first-column fallback on a junction table, for example). */
  hasDuplicateKeys: boolean;
};

/** Rows per table key, in order of first appearance. */
function collectRows(statements: Located[]): Map<string, TableRows> {
  const tables = new Map<string, TableRows>();
  for (const statement of statements) {
    if (statement.kind !== "rows") continue;
    let table = tables.get(statement.table.key);
    if (!table) {
      table = {
        table: statement.table,
        keyColumns: statement.keyColumns,
        rows: [],
        deletesMissing: false,
        hasDuplicateKeys: false,
      };
      tables.set(statement.table.key, table);
    }
    table.deletesMissing ||= statement.deletesMissing;
    const columns = statement.columns.map((column) => column.toLowerCase()).join(", ");
    for (const row of statement.rows) {
      table.rows.push({
        ...row,
        path: statement.path,
        columns,
        mode: statement.mode,
        guard: statement.guard,
        action: statement.action,
      });
    }
  }
  for (const table of tables.values()) {
    table.hasDuplicateKeys = new Set(table.rows.map((row) => row.key)).size !== table.rows.length;
  }
  return tables;
}

/**
 * Rows by key. When keys repeat on either side, rows are keyed by their whole content instead, so
 * no row hides another; a changed row then reads as added plus removed.
 */
function indexRows(rows: KeyedRow[], byContent: boolean): Map<string, KeyedRow> {
  return new Map(rows.map((row) => [byContent ? `${row.columns}|${row.values}` : row.key, row]));
}

function isSameRow(a: KeyedRow, b: KeyedRow): boolean {
  return (
    a.values === b.values &&
    a.columns === b.columns &&
    a.mode === b.mode &&
    a.guard === b.guard &&
    a.action === b.action
  );
}

function getStatementKey(statement: OtherStatement): string {
  return statement.kind === "insert-query"
    ? `${statement.kind}|${statement.mode}|${statement.text}`
    : `${statement.kind}|${statement.text}`;
}

const MODE_TEXT: Record<ConflictMode, string> = {
  update: "an upsert that overwrites existing rows",
  ignore: "a guard that skips existing rows",
  none: "no conflict guard",
};

function describeKeys(rows: KeyedRow[]): string {
  const listed = rows.slice(0, MAX_LISTED).map((row) => row.key);
  const more = rows.length - listed.length;
  return `${listed.join("; ")}${more > 0 ? ` and ${more} more` : ""}`;
}

function describeKeyColumns(table: TableRows): string {
  return table.keyColumns.length === 0 ? "the first value" : table.keyColumns.join(", ");
}

type RowGroup = { id: SeedRuleId; rows: KeyedRow[]; tree: TreeRef };

function getRowMessage(id: SeedRuleId, table: TableRows, rows: KeyedRow[], byContent: boolean): string {
  const name = table.table.display;
  const keys = byContent
    ? `rows cannot be told apart by ${describeKeyColumns(table)}, so they are compared whole: ${describeKeys(rows)}`
    : `${describeKeyColumns(table)} ${describeKeys(rows)}`;
  const count = `${rows.length} row(s)`;
  switch (id) {
    case "row-added":
      return `adds ${count} to ${name} (${keys}) under ${MODE_TEXT[rows[0]?.mode ?? "update"]}; old builds ignore rows they do not know`;
    case "row-removed":
      return `no longer seeds ${count} of ${name} (${keys}); the rows stay in databases that have them`;
    case "row-added-skipped":
      return `adds ${count} to ${name} (${keys}) inside an IF NOT EXISTS block that is already false where the table has rows: those databases skip the whole block, so they never get these rows`;
    case "row-changed":
      return `changes ${count} of ${name} (${keys}), or the upsert that writes them, under an upsert: every deploy overwrites the production rows, old builds read the new values, and a rollback does not restore the old ones`;
    case "row-change-ignored":
      return `changes ${count} of ${name} (${keys}) under a guard that skips existing rows: databases that already have them keep the old values; only empty databases get the change`;
    case "row-deleted":
      return `drops ${count} of ${name} (${keys}) from a MERGE that deletes rows missing from its source: the deploy deletes them from production, and old builds may still need them`;
    default:
      return `inserts ${count} into ${name} (${keys}) without a conflict guard: the seed runs on every deploy, so the insert fails on a duplicate key or adds the rows again`;
  }
}

type Location = { path: string; line: number };

function buildEvidence(tree: TreeRef, locations: Location[]): Evidence[] {
  const seen = new Set<string>();
  const evidence: Evidence[] = [];
  for (const { path, line } of locations) {
    const key = `${path}:${line}`;
    if (seen.has(key)) continue;
    seen.add(key);
    evidence.push({ side: tree.side, ref: tree.ref, commit: tree.commit, path, line });
  }
  return evidence.slice(0, MAX_LISTED);
}

type FindingInput = { id: SeedRuleId; object: string; path: string; message: string; evidence: Evidence[] };

function buildFinding(
  options: ClassifySeedSourceOptions,
  { id, object, path, message, evidence }: FindingInput,
): ClassifiedFinding {
  return {
    object,
    finding: {
      layer: SEED_LAYER,
      scope: options.sourceName,
      id,
      subject: `${path}: ${object}`,
      class: SEED_RULE_CLASSES[id],
      message,
      evidence,
    },
  };
}

/** Whether a guard condition names one of the key columns, so it checks a row rather than the whole table. */
function isRowGuard(guard: string, keyColumns: string[]): boolean {
  return keyColumns.some((column) => guard.includes(column.toUpperCase()));
}

function compareRows(options: ClassifySeedSourceOptions, base: Located[], revision: Located[]) {
  const baseTables = collectRows(base);
  const revisionTables = collectRows(revision);
  const findings: ClassifiedFinding[] = [];
  const baseGuards = new Set(
    [...baseTables.values()]
      .flatMap((table) => table.rows.map((row) => row.guard))
      .filter((guard) => guard !== null),
  );
  const tableKeys = [...new Set([...revisionTables.keys(), ...baseTables.keys()])];
  for (const tableKey of tableKeys) {
    const before = baseTables.get(tableKey);
    const after = revisionTables.get(tableKey);
    const table = (after ?? before) as TableRows;
    const byContent = Boolean(before?.hasDuplicateKeys || after?.hasDuplicateKeys);
    const beforeRows = indexRows(before?.rows ?? [], byContent);
    const afterRows = indexRows(after?.rows ?? [], byContent);
    const groups = new Map<SeedRuleId, RowGroup>();
    const add = (id: SeedRuleId, row: KeyedRow, tree: TreeRef) => {
      const group = groups.get(id) ?? { id, rows: [], tree };
      group.rows.push(row);
      groups.set(id, group);
    };
    for (const [key, row] of afterRows) {
      const old = beforeRows.get(key);
      if (old !== undefined && isSameRow(old, row)) continue;
      if (row.mode === "none") add("insert-unguarded", row, options.revisionTree);
      else if (old !== undefined)
        add(row.mode === "update" ? "row-changed" : "row-change-ignored", row, options.revisionTree);
      // Keyed by content, an upsert's changed row cannot be told from a new one; assume the worse.
      else if (byContent && before !== undefined && row.mode === "update")
        add("row-changed", row, options.revisionTree);
      else if (
        row.guard !== null &&
        (baseGuards.has(row.guard) || (before !== undefined && !isRowGuard(row.guard, table.keyColumns)))
      )
        add("row-added-skipped", row, options.revisionTree);
      else add("row-added", row, options.revisionTree);
    }
    for (const [key, row] of beforeRows) {
      if (afterRows.has(key)) continue;
      if (after?.deletesMissing) add("row-deleted", row, options.revisionTree);
      else add("row-removed", row, options.baseTree);
    }
    const deletingMerges: Location[] = revision.filter(
      (item) => item.kind === "rows" && item.table.key === tableKey && item.deletesMissing,
    );
    if (before !== undefined && after?.deletesMissing && !before.deletesMissing) {
      findings.push(
        buildFinding(options, {
          id: "delete-data",
          object: table.table.display,
          path: (deletingMerges[0] as Location).path,
          message: `a MERGE now deletes every row of ${table.table.display} missing from its source: rows that production added or that earlier seeds wrote are deleted on deploy`,
          evidence: buildEvidence(options.revisionTree, deletingMerges),
        }),
      );
    }
    for (const group of groups.values()) {
      // A deleted row has no revision line of its own; point at the deleting MERGE.
      const locations = group.id === "row-deleted" ? deletingMerges : group.rows;
      findings.push(
        buildFinding(options, {
          id: group.id,
          object: table.table.display,
          path: (locations[0] as Location).path,
          message: getRowMessage(group.id, table, group.rows, byContent),
          evidence: buildEvidence(group.tree, locations),
        }),
      );
    }
  }
  return findings;
}

function classifyOther(statement: OtherStatement): { id: SeedRuleId; message: string }[] {
  if (statement.kind === "unknown-write") {
    return [
      {
        id: "unreadable-write",
        message: `writes rows in a shape the seed layer cannot read (${statement.text.slice(0, 80)}${statement.text.length > 80 ? "..." : ""}); check what it does to existing rows`,
      },
    ];
  }
  const name = statement.table.display;
  switch (statement.kind) {
    case "update":
      return [
        {
          id: "update-data",
          message: `updates existing rows of ${name} on every deploy: old builds keep running on the changed data, and a rollback does not undo it`,
        },
      ];
    case "delete":
      return [
        {
          id: "delete-data",
          message: `deletes rows of ${name} on every deploy: old builds may still need them, and a rollback does not restore them`,
        },
      ];
    case "truncate":
      return [
        {
          id: "truncate",
          message: `deletes every row of ${name} on every deploy; old builds lose the data they rely on until the seed refills it`,
        },
      ];
    case "insert-query":
      if (statement.mode === "ignore")
        return [
          {
            id: "insert-query-added",
            message: `inserts rows into ${name} from a query, only where they are missing`,
          },
        ];
      if (statement.mode === "update")
        return [
          {
            id: "upsert-query",
            message: `upserts rows of ${name} from a query: every deploy may overwrite production rows, and a rollback does not restore them`,
          },
        ];
      return [
        {
          id: "insert-unguarded",
          message: `inserts rows into ${name} from a query without a conflict guard: the seed runs on every deploy, so the insert fails on a duplicate key or adds the rows again`,
        },
      ];
    case "merge-query": {
      const results: { id: SeedRuleId; message: string }[] = [];
      if (statement.deletes)
        results.push({
          id: "delete-data",
          message: `merges into ${name} with a DELETE clause: every deploy may delete production rows, and a rollback does not restore them`,
        });
      if (statement.updates)
        results.push({
          id: "upsert-query",
          message: `merges into ${name} with an UPDATE clause: every deploy may overwrite production rows, and a rollback does not restore them`,
        });
      if (results.length === 0 && statement.inserts)
        results.push({
          id: "insert-query-added",
          message: `merges rows into ${name}, inserting only where they are missing`,
        });
      return results;
    }
  }
}

/** A query insert or an insert-only `MERGE`: it only adds rows that are missing. */
function isInsertOnlyQuery(
  statement: OtherStatement,
): statement is Extract<OtherStatement, { table: SqlName }> {
  return (
    (statement.kind === "insert-query" && statement.mode === "ignore") ||
    (statement.kind === "merge-query" && statement.inserts && !statement.updates && !statement.deletes)
  );
}

function compareOther(options: ClassifySeedSourceOptions, base: Located[], revision: Located[]) {
  const remaining = new Map<string, number>();
  // Statements are compared across every file of the source, so moving one between files is no change.
  for (const statement of base) {
    if (statement.kind === "rows") continue;
    const key = getStatementKey(statement);
    remaining.set(key, (remaining.get(key) ?? 0) + 1);
  }
  const added: OtherStatement[] = [];
  for (const statement of revision) {
    if (statement.kind === "rows") continue;
    const key = getStatementKey(statement);
    const count = remaining.get(key) ?? 0;
    if (count > 0) remaining.set(key, count - 1);
    else added.push(statement);
  }
  // Tables whose insert-only query the revision edited or dropped: an edited one skips existing rows.
  const editedQueryTables = new Set(
    base
      .filter((statement): statement is OtherStatement => statement.kind !== "rows")
      .filter(isInsertOnlyQuery)
      .filter((statement) => (remaining.get(getStatementKey(statement)) ?? 0) > 0)
      .map((statement) => statement.table.key),
  );
  const findings: ClassifiedFinding[] = [];
  for (const statement of added) {
    const results =
      isInsertOnlyQuery(statement) && editedQueryTables.has(statement.table.key)
        ? [
            {
              id: "row-change-ignored" as const,
              message: `changes a query insert into ${statement.table.display} that only inserts missing rows: databases that already have the rows keep the old values; only empty databases get the change`,
            },
          ]
        : classifyOther(statement);
    for (const { id, message } of results) {
      findings.push(
        buildFinding(options, {
          id,
          object: statement.kind === "unknown-write" ? "statement" : statement.table.display,
          path: statement.path,
          message,
          evidence: buildEvidence(options.revisionTree, [statement]),
        }),
      );
    }
  }
  return findings;
}

/**
 * Compares the base and revision versions of a source's seed files. Rows are compared per table and
 * key across every file of the source (so moving rows or renaming a file is no change), other writes
 * by their normalised text; only what the revision adds or changes is classified.
 */
export function classifySeedSource(options: ClassifySeedSourceOptions): ClassifiedFinding[] {
  const locate = (side: "base" | "revision") =>
    options.files.flatMap((file) =>
      (file[side] ?? []).map((statement): Located => ({ ...statement, path: file.path })),
    );
  const base = locate("base");
  const revision = locate("revision");
  const removedFiles = options.files
    .filter((file) => file.base !== null && file.revision === null)
    .map((file) =>
      buildFinding(options, {
        id: "seed-file-removed",
        object: file.path,
        path: file.path,
        message:
          "the seed file is gone from the revision: its statements stop running, and the rows it seeded stay in databases that have them",
        evidence: [
          {
            side: options.baseTree.side,
            ref: options.baseTree.ref,
            commit: options.baseTree.commit,
            path: file.path,
          },
        ],
      }),
    );
  return [...removedFiles, ...compareOther(options, base, revision), ...compareRows(options, base, revision)];
}

/**
 * Marks findings matched by an accept entry (rule id and, when given, the object, case-insensitively).
 * An accepted finding keeps its class and does not count for the gate.
 */
export function applySeedAccept(
  classified: ClassifiedFinding[],
  accept: SeedAcceptEntry[],
): { findings: Finding[]; usage: { entry: SeedAcceptEntry; count: number }[] } {
  const usage = accept.map((entry) => ({ entry, count: 0 }));
  const findings = classified.map(({ finding, object }) => {
    const used = usage.find(
      ({ entry }) =>
        entry.id === finding.id &&
        (entry.object === undefined || entry.object.toLowerCase() === object.toLowerCase()),
    );
    if (!used) return finding;
    used.count += 1;
    return { ...finding, accepted: { reason: used.entry.reason } };
  });
  return { findings, usage };
}
