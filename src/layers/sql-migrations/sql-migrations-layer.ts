import type { Finding, LayerResult } from "../../model/finding.js";
import type { Result } from "../../result.js";
import { defineLayer, type LayerContext } from "../layer.js";
import { applyAccept, type ClassifiedFinding, classifyMigrations, SQL_MIGRATIONS_LAYER } from "./classify.js";
import { type MigrationSource, type SqlMigrationsConfig, sqlMigrationsConfigSchema } from "./config.js";
import { applyPreconditions, getPreconditionTables, readMaxIds } from "./preconditions.js";
import { type ChangedMigration, readSourceChanges } from "./sources.js";

type SourceOutcome = { findings: Finding[]; notes: string[] };

export const sqlMigrationsLayer = defineLayer({
  name: SQL_MIGRATIONS_LAYER,
  description:
    "Database migrations: statements of the migrations new in the revision, classified per dialect",
  configSchema: sqlMigrationsConfigSchema,
  async run(context) {
    const findings: Finding[] = [];
    const notes: string[] = [];
    const errors: string[] = [];
    // Every source is checked even when one fails, so the findings of the others still reach the gate.
    for (const source of context.config.sources) {
      const outcome = await checkSource(context, source);
      if (!outcome.ok) {
        errors.push(`source "${source.name}": ${outcome.error}`);
        continue;
      }
      findings.push(...outcome.value.findings);
      notes.push(...outcome.value.notes);
    }
    if (errors.length > 0) {
      return {
        layer: SQL_MIGRATIONS_LAYER,
        status: "failed",
        error: errors.join("; "),
        findings,
        notes,
      } satisfies LayerResult;
    }
    return { layer: SQL_MIGRATIONS_LAYER, status: "ran", findings, notes } satisfies LayerResult;
  },
});

async function checkSource(
  context: LayerContext<SqlMigrationsConfig>,
  source: MigrationSource,
): Promise<Result<SourceOutcome>> {
  const changes = await readSourceChanges({ source, base: context.base, revision: context.revision });
  if (!changes.ok) return changes;
  const { newMigrations, changed, baseTables } = changes.value;
  const classified = classifyMigrations({
    sourceName: source.name,
    dialect: source.dialect,
    migrations: newMigrations,
    baseTables,
    revision: context.revision,
  });
  classified.push(...changed.map((item) => describeChange(context, source, item)));
  const preconditionNotes = await resolvePreconditions(context, source, classified);
  const { findings, usage } = applyAccept(classified, source.accept ?? []);
  const statementCount = newMigrations.reduce((sum, migration) => sum + migration.statements.length, 0);
  const notes = [
    `source "${source.name}": ${newMigrations.length} new migration(s), ${statementCount} statement(s) read`,
    ...preconditionNotes,
    ...usage.map(({ entry, count }) => {
      const target = `${entry.id} in ${entry.migration}${entry.object ? ` on ${entry.object}` : ""}`;
      return count === 0
        ? `source "${source.name}": accept entry ${target} matched nothing; remove it if the change is gone`
        : `source "${source.name}": accept entry ${target} accepted ${count} finding(s)`;
    }),
  ];
  return { ok: true, value: { findings, notes } };
}

/**
 * Runs the source's preconditions command once, only when an explicit-id insert needs production
 * `max(id)`. A failing command is a note: the findings keep their class.
 */
async function resolvePreconditions(
  context: LayerContext<SqlMigrationsConfig>,
  source: MigrationSource,
  classified: ClassifiedFinding[],
): Promise<string[]> {
  const tables = getPreconditionTables(classified);
  if (source.preconditions === undefined || tables.length === 0) return [];
  const maxIds = await readMaxIds({
    preconditions: source.preconditions,
    tables,
    dialect: source.dialect,
    cwd: context.repoDir,
    env: context.env,
  });
  if (!maxIds.ok) {
    return [`source "${source.name}": ${maxIds.error}; explicit-id inserts stay unresolved`];
  }
  applyPreconditions(classified, maxIds.value);
  return [`source "${source.name}": preconditions command listed ${maxIds.value.size} table(s)`];
}

function describeChange(
  context: LayerContext<SqlMigrationsConfig>,
  source: MigrationSource,
  change: ChangedMigration,
): ClassifiedFinding {
  const tree = change.side === "base" ? context.base : context.revision;
  const isModified = change.kind === "modified";
  return {
    migration: change.migration,
    object: change.migration,
    finding: {
      layer: SQL_MIGRATIONS_LAYER,
      scope: source.name,
      id: isModified ? "migration-modified" : "migration-removed",
      subject: change.migration,
      class: "needs-action",
      message: isModified
        ? "a migration that the base already had was edited; production already ran the old version and never runs the edit"
        : "a migration that the base had is gone from the revision; production already ran it, and tools that check the applied migrations may refuse the release",
      evidence: [{ side: tree.side, ref: tree.ref, commit: tree.commit, path: change.path }],
    },
  };
}
