import type { RefTree } from "../../git/ref-tree.js";
import type { Side } from "../../model/finding.js";
import { err, ok, type Result } from "../../result.js";
import { splitStatements } from "../../sql/statements.js";
import { getCreatedTables, type Migration } from "./classify.js";
import type { MigrationSource } from "./config.js";
import { parseEfScript } from "./ef-script.js";

export type ChangedMigration = {
  kind: "modified" | "removed";
  migration: string;
  path: string;
  /** The side where the migration still exists, for evidence. */
  side: Side;
};

export type SourceChanges = {
  /** Migrations of the revision that the base does not have, in the order they run. */
  newMigrations: Migration[];
  /** Migrations the base already had that the revision edited or removed. */
  changed: ChangedMigration[];
  /** Keys of the tables the base's migrations create. */
  baseTables: Set<string>;
};

export type ReadSourceOptions = { source: MigrationSource; base: RefTree; revision: RefTree };

/** Migration id given to statements of an EF script that sit outside every migration guard. */
export const UNGUARDED_MIGRATION = "(outside migration guards)";

function normalizeSql(sql: string): string {
  return sql.replace(/\s+/g, " ");
}

type FolderSource = Extract<MigrationSource, { kind: "folder" }>;
type EfScriptSource = Extract<MigrationSource, { kind: "ef-script" }>;

export function readSourceChanges(options: ReadSourceOptions): Promise<Result<SourceChanges>> {
  const { source } = options;
  return source.kind === "folder" ? readFolder(source, options) : readEfScript(source, options);
}

async function readText(tree: RefTree, path: string): Promise<Result<string | null>> {
  const content = await tree.readFile(path);
  if (!content.ok) return err(`cannot read ${path} at ${tree.side} ${tree.ref}: ${content.error}`);
  return content;
}

async function readFolder(
  source: FolderSource,
  { base, revision }: ReadSourceOptions,
): Promise<Result<SourceChanges>> {
  const prefix = source.path === "" ? "" : `${source.path}/`;
  const globs = source.include.map((glob) => `${prefix}${glob}`);
  const [baseFiles, revisionFiles] = await Promise.all([base.listFiles(globs), revision.listFiles(globs)]);
  if (!baseFiles.ok) return baseFiles;
  if (!revisionFiles.ok) return revisionFiles;
  if (revisionFiles.value.length === 0) {
    return err(`no migration file matches ${globs.join(", ")} at revision ${revision.ref}`);
  }
  const toId = (path: string) => path.slice(prefix.length);
  const revisionSet = new Set(revisionFiles.value);
  const baseMigrations: Migration[] = [];
  const changed: ChangedMigration[] = [];
  for (const path of baseFiles.value) {
    const baseText = await readText(base, path);
    if (!baseText.ok) return baseText;
    const text = baseText.value ?? "";
    baseMigrations.push({ id: toId(path), path, statements: splitStatements(text, source.dialect) });
    if (!revisionSet.has(path)) {
      changed.push({ kind: "removed", migration: toId(path), path, side: "base" });
      continue;
    }
    const revisionText = await readText(revision, path);
    if (!revisionText.ok) return revisionText;
    if (revisionText.value !== text)
      changed.push({ kind: "modified", migration: toId(path), path, side: "revision" });
  }
  const baseSet = new Set(baseFiles.value);
  const newMigrations: Migration[] = [];
  for (const path of revisionFiles.value.filter((file) => !baseSet.has(file))) {
    const text = await readText(revision, path);
    if (!text.ok) return text;
    newMigrations.push({
      id: toId(path),
      path,
      statements: splitStatements(text.value ?? "", source.dialect),
    });
  }
  return ok({ newMigrations, changed, baseTables: getCreatedTables(baseMigrations, source.dialect) });
}

async function readEfScript(
  source: EfScriptSource,
  { base, revision }: ReadSourceOptions,
): Promise<Result<SourceChanges>> {
  const revisionText = await readText(revision, source.path);
  if (!revisionText.ok) return revisionText;
  if (revisionText.value === null)
    return err(`EF script ${source.path} does not exist at revision ${revision.ref}`);
  const baseText = await readText(base, source.path);
  if (!baseText.ok) return baseText;
  const revisionScript = parseEfScript(revisionText.value, source.dialect, source.historyTable);
  if (!revisionScript.ok) return err(`${source.path} at revision ${revision.ref}: ${revisionScript.error}`);
  const baseScript =
    baseText.value === null
      ? ok({ migrations: [], unguarded: [] })
      : parseEfScript(baseText.value, source.dialect, source.historyTable);
  if (!baseScript.ok) return err(`${source.path} at base ${base.ref}: ${baseScript.error}`);

  const toMigration = ({
    id,
    statements,
  }: {
    id: string;
    statements: Migration["statements"];
  }): Migration => ({
    id,
    path: source.path,
    statements,
  });
  const baseIds = new Set(baseScript.value.migrations.map((migration) => migration.id));
  const revisionIds = new Set(revisionScript.value.migrations.map((migration) => migration.id));
  const newMigrations = revisionScript.value.migrations
    .filter((migration) => !baseIds.has(migration.id))
    .map(toMigration);
  // Hand-written SQL outside the guards runs on every deploy; only what the revision added is new.
  const baseUnguarded = new Set(baseScript.value.unguarded.map((statement) => normalizeSql(statement.sql)));
  const newUnguarded = revisionScript.value.unguarded.filter(
    (statement) => !baseUnguarded.has(normalizeSql(statement.sql)),
  );
  if (newUnguarded.length > 0)
    newMigrations.push(toMigration({ id: UNGUARDED_MIGRATION, statements: newUnguarded }));
  return ok({
    newMigrations,
    changed: baseScript.value.migrations
      .filter((migration) => !revisionIds.has(migration.id))
      .map((migration) => ({ kind: "removed", migration: migration.id, path: source.path, side: "base" })),
    baseTables: getCreatedTables(baseScript.value.migrations.map(toMigration), source.dialect),
  });
}
