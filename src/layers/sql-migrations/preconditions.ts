import { z } from "zod";
import type { Finding } from "../../model/finding.js";
import { describeProcessError, runProcess } from "../../process/run-process.js";
import { err, ok, type Result } from "../../result.js";
import { parseName } from "../../sql/identifiers.js";
import type { SqlDialect } from "../../sql/statements.js";
import type { ClassifiedFinding } from "./classify.js";

export const DEFAULT_PRECONDITIONS_TIMEOUT_SECONDS = 60;

/** A command that prints `table<TAB>maxId` for the tables listed in `COMPAT_TABLES`, one per line. */
export const preconditionsSchema = z.strictObject({
  run: z.string().min(1),
  timeoutSeconds: z.number().int().positive().max(3600).optional(),
});

export type PreconditionsSettings = z.infer<typeof preconditionsSchema>;

/** Production `max(id)` per table key; `null` means the table has no rows. */
export type MaxIds = Map<string, number | null>;

const LABEL = "preconditions command";

/** Explicit-id inserts whose precondition is a production `max(id)` below the first inserted id. */
function getResolvable(classified: ClassifiedFinding[]) {
  return classified.flatMap((item) => {
    const insert = item.explicitIds;
    if (insert === undefined || insert.ids.range === null || item.finding.class !== "needs-action") return [];
    return [{ item, insert, first: insert.ids.range.first }];
  });
}

/** The tables, as the report shows them, whose explicit-id inserts the command can settle. */
export function getPreconditionTables(classified: ClassifiedFinding[]): string[] {
  return [...new Set(getResolvable(classified).map(({ insert }) => insert.table.display))];
}

/**
 * Reads `table<TAB>maxId` lines. An empty or `NULL` max means an empty table; blank lines, `#`
 * comments and lines without an integer max are skipped, so nothing else from the output is kept.
 */
export function parsePreconditionsOutput(output: string, dialect: SqlDialect): MaxIds {
  const maxIds: MaxIds = new Map();
  for (const line of output.split(/\r?\n/)) {
    const [table, max, ...rest] = line.split("\t").map((part) => part.trim());
    if (
      table === undefined ||
      table === "" ||
      table.startsWith("#") ||
      max === undefined ||
      rest.length > 0
    ) {
      continue;
    }
    const { key } = parseName(table, dialect);
    if (max === "" || max.toLowerCase() === "null") maxIds.set(key, null);
    else if (/^-?\d+$/.test(max)) maxIds.set(key, Number(max));
  }
  return maxIds;
}

type ReadMaxIdsOptions = {
  preconditions: PreconditionsSettings;
  tables: string[];
  dialect: SqlDialect;
  cwd: string;
  env: NodeJS.ProcessEnv;
};

/**
 * Runs the preconditions command in the consumer's working directory with the tables in
 * `COMPAT_TABLES`. Errors never quote the command's output.
 */
export async function readMaxIds({
  preconditions,
  tables,
  dialect,
  cwd,
  env,
}: ReadMaxIdsOptions): Promise<Result<MaxIds>> {
  const timeoutSeconds = preconditions.timeoutSeconds ?? DEFAULT_PRECONDITIONS_TIMEOUT_SECONDS;
  const result = await runProcess({
    command: preconditions.run,
    shell: true,
    cwd,
    env: { ...env, COMPAT_TABLES: tables.join("\n") },
    timeoutMs: timeoutSeconds * 1000,
  });
  if (!result.ok) return err(describeProcessError(LABEL, result.error));
  if (result.value.exitCode !== 0) return err(`${LABEL} exited ${result.value.exitCode}`);
  return ok(parsePreconditionsOutput(result.value.stdout, dialect));
}

/**
 * Settles explicit-id inserts with production `max(id)`: at or above the first inserted id the
 * insert collides (`breaking`); below it the rows fit, and the finding is `safe` when the migration
 * also moves the identity sequence past them. A table the command did not list stays as it was.
 */
export function applyPreconditions(classified: ClassifiedFinding[], maxIds: MaxIds): void {
  for (const { item, insert, first } of getResolvable(classified)) {
    const column = insert.ids.column ?? "the identity column";
    const finding: Finding = item.finding;
    if (!maxIds.has(insert.table.key)) {
      finding.message = `${finding.message}; ${insert.table.display} not listed by the ${LABEL}`;
      continue;
    }
    const max = maxIds.get(insert.table.key) ?? null;
    if (max !== null && max >= first) {
      finding.class = "breaking";
      finding.message = `${finding.message}; production max(${column}) = ${max} >= ${first}, the insert collides (${LABEL})`;
      continue;
    }
    const observed =
      max === null
        ? `production ${insert.table.display} is empty`
        : `production max(${column}) = ${max} < ${first}`;
    if (insert.isSequenceMoved) finding.class = "safe";
    finding.message = insert.isSequenceMoved
      ? `${finding.message}; ${observed} (${LABEL})`
      : `${finding.message}; ${observed} (${LABEL}); the identity sequence half remains`;
  }
}
