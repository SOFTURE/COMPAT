import { z } from "zod";
import { CONFIG_FINDING_IDS } from "./classify.js";
import { COMMENT_STYLES } from "./comments.js";

export const DEFAULT_COMPOSE_FILES = ["**/{docker-compose,compose}{,.*}.{yml,yaml}"];

export const DEFAULT_DOTENV_FILES = ["**/.env.{example,sample,template,dist}", "**/{example,sample}.env"];

const sourceName = z.string().regex(/^[A-Za-z0-9._-]+$/, "use letters, digits, '.', '_' or '-'");

const globs = z.array(z.string().min(1)).min(1);

/** Compiles a configured pattern, or returns why it cannot be used. */
export function compileKeyPattern(pattern: string, flags: string): { regex: RegExp } | { error: string } {
  let regex: RegExp;
  try {
    // `d` gives match indices, so evidence points at the line of the key, not the start of the match.
    regex = new RegExp(pattern, `${flags}dg`);
  } catch (error) {
    return { error: `is not a valid regular expression: ${(error as Error).message}` };
  }
  // An empty alternative always matches, so `groups` lists every named group of the pattern.
  const groups = new RegExp(`(?:${pattern})|`, flags).exec("")?.groups ?? {};
  if (!Object.hasOwn(groups, "key")) return { error: "must contain a named group (?<key>...)" };
  return { regex };
}

const regexSourceSchema = z
  .strictObject({
    kind: z.literal("regex"),
    name: sourceName,
    files: globs,
    pattern: z.string().min(1),
    flags: z
      .string()
      .regex(/^[imsu]*$/, "use only the flags i, m, s and u")
      .refine((flags) => new Set(flags).size === flags.length, "must not repeat a flag")
      .default(""),
    comments: z.enum(COMMENT_STYLES).default("none"),
  })
  .superRefine((source, context) => {
    // The flags issue is already reported; compiling with them would only repeat it.
    if (!/^[imsu]*$/.test(source.flags) || new Set(source.flags).size !== source.flags.length) return;
    const compiled = compileKeyPattern(source.pattern, source.flags);
    if ("error" in compiled) context.addIssue({ code: "custom", path: ["pattern"], message: compiled.error });
  });

export const configSourceSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("compose"),
    name: sourceName.default("compose"),
    files: globs.default(DEFAULT_COMPOSE_FILES),
  }),
  z.strictObject({
    kind: z.literal("dotenv"),
    name: sourceName.default("dotenv"),
    files: globs.default(DEFAULT_DOTENV_FILES),
    valuesAreDefaults: z.boolean().default(false),
  }),
  regexSourceSchema,
]);

export type ConfigSource = z.infer<typeof configSourceSchema>;

export const configAcceptEntrySchema = z.strictObject({
  key: z.string().min(1),
  /** Required, so accepting a new key never also hides a later change of the same key. */
  id: z.enum(CONFIG_FINDING_IDS),
  reason: z.string().min(1),
});

export const configLayerConfigSchema = z.strictObject({
  sources: z
    .array(configSourceSchema)
    .min(1)
    .refine(
      (sources) => new Set(sources.map((source) => source.name)).size === sources.length,
      "source names must be unique; name sources of the same kind with `name`",
    ),
  accept: z.array(configAcceptEntrySchema).optional(),
});

export type ConfigLayerConfig = z.infer<typeof configLayerConfigSchema>;
