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

export type ClassifySeedFileOptions = {
  sourceName: string;
  /** Repository-relative path of the seed file. */
  path: string;
  /** Statements of the file at the base; `null` when the file is new in the revision. */
  base: SeedStatement[] | null;
  /** Statements of the file at the revision; `null` when the revision removed the file. */
  revision: SeedStatement[] | null;
  baseTree: TreeRef;
  revisionTree: TreeRef;
};

type RowsStatement = Extract<SeedStatement, { kind: "rows" }>;
type OtherStatement = Exclude<SeedStatement, RowsStatement>;

type KeyedRow = SeedRow & { columns: string; mode: ConflictMode; guard: string | null; action: string };

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
function collectRows(statements: SeedStatement[]): Map<string, TableRows> {
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
      return `adds ${count} to ${name} (${keys}) inside an IF NOT EXISTS block the base already had: databases where the block already ran skip the whole block, so they never get these rows`;
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

function buildEvidence(tree: TreeRef, path: string, lines: number[]): Evidence[] {
  return [...new Set(lines)]
    .slice(0, MAX_LISTED)
    .map((line) => ({ side: tree.side, ref: tree.ref, commit: tree.commit, path, line }));
}

function buildFinding(
  options: ClassifySeedFileOptions,
  id: SeedRuleId,
  object: string,
  message: string,
  evidence: Evidence[],
): ClassifiedFinding {
  return {
    object,
    finding: {
      layer: SEED_LAYER,
      scope: options.sourceName,
      id,
      subject: `${options.path}: ${object}`,
      class: SEED_RULE_CLASSES[id],
      message,
      evidence,
    },
  };
}

function compareRows(options: ClassifySeedFileOptions, base: SeedStatement[], revision: SeedStatement[]) {
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
      else if (row.guard !== null && baseGuards.has(row.guard))
        add("row-added-skipped", row, options.revisionTree);
      else add("row-added", row, options.revisionTree);
    }
    for (const [key, row] of beforeRows) {
      if (afterRows.has(key)) continue;
      if (after?.deletesMissing) add("row-deleted", row, options.revisionTree);
      else add("row-removed", row, options.baseTree);
    }
    if (before !== undefined && after?.deletesMissing && !before.deletesMissing) {
      const lines = revision
        .filter((item) => item.kind === "rows" && item.table.key === tableKey && item.deletesMissing)
        .map((item) => item.line);
      findings.push(
        buildFinding(
          options,
          "delete-data",
          table.table.display,
          `a MERGE now deletes every row of ${table.table.display} missing from its source: rows that production added or that earlier seeds wrote are deleted on deploy`,
          buildEvidence(options.revisionTree, options.path, lines),
        ),
      );
    }
    for (const group of groups.values()) {
      // A deleted row has no revision line of its own; point at the deleting MERGE.
      const lines =
        group.id === "row-deleted"
          ? revision
              .filter((item) => item.kind === "rows" && item.table.key === tableKey && item.deletesMissing)
              .map((item) => item.line)
          : group.rows.map((row) => row.line);
      findings.push(
        buildFinding(
          options,
          group.id,
          table.table.display,
          getRowMessage(group.id, table, group.rows, byContent),
          buildEvidence(group.tree, options.path, lines),
        ),
      );
    }
  }
  return findings;
}

function classifyOther(statement: OtherStatement): { id: SeedRuleId; message: string }[] {
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

function compareOther(options: ClassifySeedFileOptions, base: SeedStatement[], revision: SeedStatement[]) {
  const remaining = new Map<string, number>();
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
  // Tables whose guarded query insert the revision edited or dropped: an edited one skips existing rows.
  const editedQueryTables = new Set(
    base
      .filter((statement) => statement.kind === "insert-query")
      .filter((statement) => (remaining.get(getStatementKey(statement)) ?? 0) > 0)
      .map((statement) => statement.table.key),
  );
  const findings: ClassifiedFinding[] = [];
  for (const statement of added) {
    const results =
      statement.kind === "insert-query" &&
      statement.mode === "ignore" &&
      editedQueryTables.has(statement.table.key)
        ? [
            {
              id: "row-change-ignored" as const,
              message: `changes a query insert into ${statement.table.display} that only inserts missing rows: databases that already have the rows keep the old values; only empty databases get the change`,
            },
          ]
        : classifyOther(statement);
    for (const { id, message } of results) {
      findings.push(
        buildFinding(
          options,
          id,
          statement.table.display,
          message,
          buildEvidence(options.revisionTree, options.path, [statement.line]),
        ),
      );
    }
  }
  return findings;
}

/**
 * Compares the base and revision versions of one seed file. Rows are compared per table and key,
 * other writes by their normalised text; only what the revision adds or changes is classified.
 */
export function classifySeedFile(options: ClassifySeedFileOptions): ClassifiedFinding[] {
  if (options.revision === null) {
    return [
      buildFinding(
        options,
        "seed-file-removed",
        options.path,
        "the seed file is gone from the revision: its statements stop running, and the rows it seeded stay in databases that have them",
        [
          {
            side: options.baseTree.side,
            ref: options.baseTree.ref,
            commit: options.baseTree.commit,
            path: options.path,
          },
        ],
      ),
    ];
  }
  const base = options.base ?? [];
  return [...compareOther(options, base, options.revision), ...compareRows(options, base, options.revision)];
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
