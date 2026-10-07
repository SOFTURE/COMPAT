import { z } from "zod";
import { SQL_DIALECTS } from "../../sql/statements.js";

const isRelative = (path: string) => !path.startsWith("/") && !/^[a-zA-Z]:[\\/]/.test(path);
const hasNoParent = (path: string) => !path.split(/[\\/]/).includes("..");

/** A repository-relative glob; a plain path is a glob that matches one file. */
const glob = z
  .string()
  .min(1)
  .refine(isRelative, "must be a relative path or glob")
  .refine(hasNoParent, "must not contain '..'");

export const seedAcceptEntrySchema = z.strictObject({
  /** Rule id, for example `update-data`. */
  id: z.string().min(1),
  /** The table as the report shows it, or the file path for `seed-file-removed`; without it the entry covers every finding of the rule. */
  object: z.string().min(1).optional(),
  reason: z.string().min(1),
});

export const seedSourceSchema = z.strictObject({
  name: z.string().regex(/^[A-Za-z0-9._-]+$/, "use letters, digits, '.', '_' or '-'"),
  dialect: z.enum(SQL_DIALECTS),
  /** Seed scripts that run on every deploy, as repository-relative globs. */
  files: z.array(glob).min(1),
  accept: z.array(seedAcceptEntrySchema).optional(),
});

export const seedConfigSchema = z.strictObject({
  sources: z
    .array(seedSourceSchema)
    .min(1)
    .refine(
      (sources) => new Set(sources.map((source) => source.name)).size === sources.length,
      "source names must be unique",
    ),
});

export type SeedConfig = z.infer<typeof seedConfigSchema>;
export type SeedSource = z.infer<typeof seedSourceSchema>;
