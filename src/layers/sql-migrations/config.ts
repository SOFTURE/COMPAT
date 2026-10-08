import { z } from "zod";
import { SQL_DIALECTS } from "../../sql/statements.js";
import { ACCEPT_BASES } from "./classify.js";
import { preconditionsSchema } from "./preconditions.js";

const DEFAULT_INCLUDE = ["**/*.sql"];
export const DEFAULT_HISTORY_TABLE = "__EFMigrationsHistory";

const isRelative = (path: string) => !path.startsWith("/") && !/^[a-zA-Z]:[\\/]/.test(path);
const hasNoParent = (path: string) => !path.split(/[\\/]/).includes("..");

/** A repository-relative path; a trailing `/` is dropped and `.` means the repository root (``). */
const folderPath = z
  .string()
  .min(1)
  .refine(isRelative, "must be a relative path")
  .refine(hasNoParent, "must not contain '..'")
  .transform((path) => path.replace(/[\\/]+$/, "").replace(/^\.(?:[\\/]|$)/, ""));

const filePath = z
  .string()
  .min(1)
  .refine(isRelative, "must be a relative path")
  .refine(hasNoParent, "must not contain '..'");

const glob = z
  .string()
  .min(1)
  .refine(isRelative, "must be a relative glob")
  .refine(hasNoParent, "must not contain '..'");

export const acceptEntrySchema = z
  .strictObject({
    /** Rule id, for example `drop-column`. */
    id: z.string().min(1),
    /** Migration id: the EF migration id, or the file path relative to the folder source. */
    migration: z.string().min(1),
    /** `table` or `table.column` as the report shows it; without it the entry covers the whole migration. */
    object: z.string().min(1).optional(),
    /**
     * `migrations-only` (`insert-explicit-id` only): the entry accepts the finding only while the base
     * shows that its migrations alone wrote the table, below the new ids (see `writers`).
     */
    basis: z.enum(ACCEPT_BASES).optional(),
    reason: z.string().min(1),
  })
  .refine((entry) => entry.basis === undefined || entry.id === "insert-explicit-id", {
    message: 'basis applies only to "insert-explicit-id"',
    path: ["basis"],
  });

/**
 * The code that may write one table outside the migrations: files of the base matching `files`
 * that contain any of `patterns` (plain text, case-sensitive) write it.
 */
export const writerSchema = z.strictObject({
  /** The table as the report shows it, for example `dictionaries.PetBreeds`. */
  table: z.string().min(1),
  files: z.array(glob).min(1),
  patterns: z.array(z.string().min(1)).min(1),
});

const common = {
  name: z.string().regex(/^[A-Za-z0-9._-]+$/, "use letters, digits, '.', '_' or '-'"),
  dialect: z.enum(SQL_DIALECTS),
  accept: z.array(acceptEntrySchema).optional(),
  preconditions: preconditionsSchema.optional(),
  writers: z.array(writerSchema).optional(),
};

export const sourceSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    ...common,
    kind: z.literal("folder"),
    path: folderPath,
    include: z.array(glob).min(1).default(DEFAULT_INCLUDE),
  }),
  z.strictObject({
    ...common,
    kind: z.literal("ef-script"),
    path: filePath,
    historyTable: z
      .string()
      .regex(/^[A-Za-z0-9_]+$/, "use letters, digits or '_'")
      .default(DEFAULT_HISTORY_TABLE),
  }),
]);

export const sqlMigrationsConfigSchema = z.strictObject({
  sources: z
    .array(sourceSchema)
    .min(1)
    .refine(
      (sources) => new Set(sources.map((source) => source.name)).size === sources.length,
      "source names must be unique",
    ),
});

export type SqlMigrationsConfig = z.infer<typeof sqlMigrationsConfigSchema>;
export type MigrationSource = z.infer<typeof sourceSchema>;
