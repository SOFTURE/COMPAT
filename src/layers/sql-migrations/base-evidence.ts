import type { RefTree } from "../../git/ref-tree.js";
import type { Evidence } from "../../model/finding.js";
import { err, ok, type Result } from "../../result.js";
import { parseName } from "../../sql/identifiers.js";
import type { SqlDialect } from "../../sql/statements.js";
import type { BaseExplicitIds, Basis, ClassifiedFinding } from "./classify.js";
import type { MigrationSource } from "./config.js";

type Writer = NonNullable<MigrationSource["writers"]>[number];

/** The first line of base code outside the migrations that contains a writer pattern of a table. */
export type WriterHit = { path: string; line: number; pattern: string };

/**
 * Per table key, what the writer search found at the base: a hit, or `null` when no file matched.
 * A table without a configured writer is absent.
 */
export type WriterSearch = Map<string, WriterHit | null>;

type FindWritersOptions = {
  writers: Writer[];
  /** Keys of the tables whose writers are wanted; the others are not searched. */
  tables: ReadonlySet<string>;
  dialect: SqlDialect;
  base: RefTree;
  /** Paths of the base's migration scripts; they never count as writers. */
  migrationPaths: ReadonlySet<string>;
};

/** Searches the base for code outside the migrations that writes the given tables. */
export async function findWriters(options: FindWritersOptions): Promise<Result<WriterSearch>> {
  const search: WriterSearch = new Map();
  for (const writer of options.writers) {
    const key = parseName(writer.table, options.dialect).key;
    if (!options.tables.has(key)) continue;
    if (search.get(key)) continue;
    const hit = await findWriter(writer, options);
    if (!hit.ok) return hit;
    search.set(key, hit.value);
  }
  return ok(search);
}

async function findWriter(writer: Writer, options: FindWritersOptions): Promise<Result<WriterHit | null>> {
  const { base, migrationPaths } = options;
  const files = await base.listFiles(writer.files);
  if (!files.ok) return err(`cannot list the writers of ${writer.table} at base ${base.ref}: ${files.error}`);
  for (const path of files.value) {
    if (migrationPaths.has(path)) continue;
    const content = await base.readFile(path);
    if (!content.ok) return err(`cannot read ${path} at base ${base.ref}: ${content.error}`);
    const hit = findPattern(content.value ?? "", writer.patterns);
    if (hit !== null) return ok({ path, ...hit });
  }
  return ok(null);
}

function findPattern(text: string, patterns: string[]): { line: number; pattern: string } | null {
  const lines = text.split(/\r?\n/);
  for (const [index, line] of lines.entries()) {
    const pattern = patterns.find((candidate) => line.includes(candidate));
    if (pattern !== undefined) return { line: index + 1, pattern };
  }
  return null;
}

/** An explicit-id insert on an existing table that is still `needs-action` (the preconditions did not settle it). */
export function isOpenInsert(item: ClassifiedFinding): boolean {
  return item.explicitIds !== undefined && item.finding.class === "needs-action";
}

type ApplyBaseEvidenceOptions = {
  baseIds: ReadonlyMap<string, BaseExplicitIds>;
  writers: WriterSearch;
  base: Pick<RefTree, "side" | "ref" | "commit">;
};

/**
 * Adds to every explicit-id insert on an existing table what the base shows without production:
 * the highest id its migrations insert explicitly, whether they move the identity sequence, and,
 * with writers configured, whether base code outside the migrations writes the table. Sets the
 * finding's `basis`; the class does not change.
 */
export function applyBaseEvidence(classified: ClassifiedFinding[], options: ApplyBaseEvidenceOptions): void {
  for (const item of classified) {
    const insert = item.explicitIds;
    if (insert === undefined || !isOpenInsert(item)) continue;
    const baseIds = options.baseIds.get(insert.table.key);
    const writer = options.writers.get(insert.table.key);
    const table = insert.table.display;
    const column = insert.ids.column ?? "ids";
    const parts = [describeBaseIds(table, column, baseIds)];
    if (writer === null) parts.push(`no base code outside the migrations matches the writers of ${table}`);
    if (writer) {
      parts.push(`base code outside the migrations writes ${table} (${writer.path}:${writer.line})`);
    }
    item.finding.message = `${item.finding.message}; ${parts.join("; ")}`;
    const toEvidence = ({ path, line }: { path: string; line: number }): Evidence => ({
      side: options.base.side,
      ref: options.base.ref,
      commit: options.base.commit,
      path,
      line,
    });
    if (baseIds?.max) item.finding.evidence.push(toEvidence(baseIds.max));
    if (baseIds?.sequenceReset) item.finding.evidence.push(toEvidence(baseIds.sequenceReset));
    if (writer) item.finding.evidence.push(toEvidence(writer));
    item.basis = getBasis({ table, first: insert.ids.range?.first ?? null, baseIds, writer });
  }
}

function describeBaseIds(table: string, column: string, baseIds: BaseExplicitIds | undefined): string {
  if (baseIds === undefined) return `the base migrations insert no explicit ids into ${table}`;
  const sequence =
    baseIds.sequenceReset === null ? "never move its identity sequence" : "move its identity sequence";
  if (baseIds.max === null) {
    return baseIds.hasUnreadIds
      ? `the base migrations insert explicit ids into ${table} that cannot be read, and ${sequence}`
      : `the base migrations insert no explicit ids into ${table}, and ${sequence}`;
  }
  const unread = baseIds.hasUnreadIds ? " (and ids that cannot be read)" : "";
  return `the base migrations insert explicit ${column} up to ${baseIds.max.id}${unread} into ${table}, and ${sequence}`;
}

type GetBasisOptions = {
  table: string;
  /** The first id the new migration inserts, or `null` when its ids cannot be read. */
  first: number | null;
  baseIds: BaseExplicitIds | undefined;
  writer: WriterHit | null | undefined;
};

/** Whether only the base's migrations wrote the table, all of it below the new ids. */
function getBasis({ table, first, baseIds, writer }: GetBasisOptions): Basis {
  if (first === null) return { holds: false, reason: "the inserted ids cannot be read" };
  if (writer === undefined) return { holds: false, reason: `no writers are configured for ${table}` };
  if (writer !== null) {
    return { holds: false, reason: `base code writes ${table} (${writer.path}:${writer.line})` };
  }
  if (baseIds === undefined || (baseIds.max === null && !baseIds.hasUnreadIds)) {
    return { holds: false, reason: `the base migrations insert no explicit ids into ${table}` };
  }
  if (baseIds.hasUnreadIds) {
    return { holds: false, reason: `the base migrations insert ids into ${table} that cannot be read` };
  }
  if (baseIds.max !== null && baseIds.max.id >= first) {
    return {
      holds: false,
      reason: `the base migrations insert id ${baseIds.max.id} into ${table}, not below ${first}`,
    };
  }
  return { holds: true };
}
