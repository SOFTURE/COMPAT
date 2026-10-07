import { z } from "zod";
import { CONFIG_FINDING_IDS } from "./classify.js";
import { COMMENT_STYLES } from "./comments.js";
import { KEY_MATCHING_MODES } from "./keys.js";
import { presenceSchema } from "./presence.js";

export const DEFAULT_COMPOSE_FILES = ["**/{docker-compose,compose}{,.*}.{yml,yaml}"];

export const DEFAULT_DOTENV_FILES = ["**/.env.{example,sample,template,dist}", "**/{example,sample}.env"];

const sourceName = z.string().regex(/^[A-Za-z0-9._-]+$/, "use letters, digits, '.', '_' or '-'");

const globs = z.array(z.string().min(1)).min(1);

/** A compiled pattern and the names of its named groups. */
export type CompiledPattern = { regex: RegExp; groups: ReadonlySet<string> };

/** Compiles a configured pattern, or returns why it cannot be used. */
export function compilePattern(pattern: string, flags: string): CompiledPattern | { error: string } {
  let regex: RegExp;
  try {
    // `d` gives match indices, so evidence points at the line of the key, not the start of the match.
    regex = new RegExp(pattern, `${flags}dg`);
  } catch (error) {
    return { error: `is not a valid regular expression: ${(error as Error).message}` };
  }
  // An empty alternative always matches, so `groups` lists every named group of the pattern.
  const groups = new RegExp(`(?:${pattern})|`, flags).exec("")?.groups ?? {};
  return { regex, groups: new Set(Object.keys(groups)) };
}

const PLACEHOLDER = /\{(\w+)\}/g;

/** The group names a key template refers to, in order: `{section}__{member}` gives `section`, `member`. */
export function getTemplatePlaceholders(template: string): string[] {
  return [...template.matchAll(PLACEHOLDER)].map((match) => match[1] as string);
}

/** Fills a key template; a placeholder `resolve` cannot fill becomes empty. */
export function renderKeyTemplate(template: string, resolve: (group: string) => string | undefined): string {
  return template.replace(PLACEHOLDER, (_, group: string) => resolve(group) ?? "");
}

export const DEFAULT_KEY_TEMPLATE = "{key}";

export type CompiledRegexSource = {
  regex: RegExp;
  /** Matches before a key whose named groups the key template may also use, e.g. the enclosing settings class. */
  enclosing: RegExp | null;
  key: string;
};

type RegexSourceSettings = { pattern: string; flags: string; key?: string; enclosing?: string };

/** Compiles the patterns of a regex source and checks its key template, or says which field is wrong. */
export function compileRegexSource(
  source: RegexSourceSettings,
): { compiled: CompiledRegexSource } | { error: string; field: "pattern" | "enclosing" | "key" } {
  const pattern = compilePattern(source.pattern, source.flags);
  if ("error" in pattern) return { error: pattern.error, field: "pattern" };
  let enclosing: CompiledPattern | null = null;
  if (source.enclosing !== undefined) {
    const compiled = compilePattern(source.enclosing, source.flags);
    if ("error" in compiled) return { error: compiled.error, field: "enclosing" };
    enclosing = compiled;
  }
  if (source.key === undefined) {
    if (enclosing !== null) {
      return {
        error: 'needs a `key` template that uses its groups, e.g. "{section}__{key}"',
        field: "enclosing",
      };
    }
    if (!pattern.groups.has("key"))
      return { error: "must contain a named group (?<key>...)", field: "pattern" };
    return { compiled: { regex: pattern.regex, enclosing: null, key: DEFAULT_KEY_TEMPLATE } };
  }
  const placeholders = getTemplatePlaceholders(source.key);
  if (placeholders.length === 0) {
    return { error: "must use at least one named group as {name}", field: "key" };
  }
  for (const group of placeholders) {
    if (!pattern.groups.has(group) && !enclosing?.groups.has(group)) {
      return { error: `uses {${group}}, which is not a named group of pattern or enclosing`, field: "key" };
    }
  }
  if (enclosing !== null && !placeholders.some((group) => enclosing.groups.has(group))) {
    return { error: "is not used: the key template takes none of its named groups", field: "enclosing" };
  }
  return { compiled: { regex: pattern.regex, enclosing: enclosing?.regex ?? null, key: source.key } };
}

/** Prepended to every key of a source that reads one section only, e.g. `Shop__`. */
const prefix = z.string().min(1).optional();

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
    key: z.string().min(1).optional(),
    enclosing: z.string().min(1).optional(),
    prefix,
  })
  .superRefine((source, context) => {
    // The flags issue is already reported; compiling with them would only repeat it.
    if (!/^[imsu]*$/.test(source.flags) || new Set(source.flags).size !== source.flags.length) return;
    const compiled = compileRegexSource(source);
    if ("error" in compiled)
      context.addIssue({ code: "custom", path: [compiled.field], message: compiled.error });
  });

export const configSourceSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("compose"),
    name: sourceName.default("compose"),
    files: globs.default(DEFAULT_COMPOSE_FILES),
    prefix,
  }),
  z.strictObject({
    kind: z.literal("dotenv"),
    name: sourceName.default("dotenv"),
    files: globs.default(DEFAULT_DOTENV_FILES),
    valuesAreDefaults: z.boolean().default(false),
    prefix,
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
  /** `normalized` compares `Shop:BaseUrl`, `Shop__BaseUrl` and `SHOP_BASE_URL` as one key; `exact` as written. */
  keyMatching: z.enum(KEY_MATCHING_MODES).default("normalized"),
  sources: z
    .array(configSourceSchema)
    .min(1)
    .refine(
      (sources) => new Set(sources.map((source) => source.name)).size === sources.length,
      "source names must be unique; name sources of the same kind with `name`",
    ),
  /** Lists the key names of the target environment, never values; resolves keys that need a value there. */
  presence: presenceSchema.optional(),
  accept: z.array(configAcceptEntrySchema).optional(),
});

export type ConfigLayerConfig = z.infer<typeof configLayerConfigSchema>;
