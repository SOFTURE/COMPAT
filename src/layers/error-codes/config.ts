import { z } from "zod";
import { refListSchema } from "../../resolve/ref-list.js";

export const ERROR_CODES_LAYER = "error-codes";

export const ERROR_CODE_FINDING_CLASSES = {
  "error-code-added": "safe",
  "error-code-removed": "safe",
  "error-code-unknown-to-client": "needs-action",
} as const;

export type ErrorCodeFindingId = keyof typeof ERROR_CODE_FINDING_CLASSES;

const name = z.string().regex(/^[A-Za-z0-9._-]+$/, "use letters, digits, '.', '_' or '-'");

const globs = z.array(z.string().min(1)).min(1);

const FLAGS = /^[imsu]*$/;

const flags = z
  .string()
  .regex(FLAGS, "use only the flags i, m, s and u")
  .refine((value) => new Set(value).size === value.length, "must not repeat a flag")
  .default("");

/** Compiles a configured pattern with `g` and `d`, or returns why it cannot be used. */
export function compileCodePattern(pattern: string, patternFlags: string): RegExp | { error: string } {
  let regex: RegExp;
  try {
    // `d` gives match indices, so evidence points at the line of the code, not the start of the match.
    regex = new RegExp(pattern, `${patternFlags}dg`);
  } catch (error) {
    return { error: `is not a valid regular expression: ${(error as Error).message}` };
  }
  // An empty alternative always matches, so `groups` lists every named group of the pattern.
  const groups = new RegExp(`(?:${pattern})|`, patternFlags).exec("")?.groups ?? {};
  if (!("code" in groups)) return { error: "must contain a named group (?<code>...)" };
  return regex;
}

/** Adds a `pattern` issue when the pattern does not compile with its flags. */
function checkPattern(source: { pattern: string; flags: string }, context: z.RefinementCtx): void {
  // A flags issue is already reported; compiling with them would only repeat it.
  if (!FLAGS.test(source.flags) || new Set(source.flags).size !== source.flags.length) return;
  const compiled = compileCodePattern(source.pattern, source.flags);
  if ("error" in compiled) context.addIssue({ code: "custom", path: ["pattern"], message: compiled.error });
}

export const regexCodeSourceSchema = z
  .strictObject({
    /** Optional, so configs written before `composed` sources keep working. */
    kind: z.literal("regex").default("regex"),
    name,
    /** Server files that declare the codes, read at the base and the revision. */
    files: globs,
    /** Regex whose named group `code` captures one error code. */
    pattern: z.string().min(1),
    flags,
    /** `false` for a source that only feeds a `composed` source: read, never reported, may capture nothing. */
    report: z.boolean().default(true),
  })
  .superRefine(checkPattern);

export type RegexCodeSource = z.infer<typeof regexCodeSourceSchema>;

const PLACEHOLDER = /\{([A-Za-z0-9_-]+)\}/g;

/** The placeholder names of a composed template, in order of appearance. */
export function getTemplateParts(template: string): string[] {
  return [...template.matchAll(PLACEHOLDER)].map((match) => match[1] as string);
}

export const composedCodeSourceSchema = z
  .strictObject({
    kind: z.literal("composed"),
    name,
    /** The code with `{part}` placeholders, for example `{entity}Repository.NotFound`. */
    template: z.string().min(1),
    /** Each placeholder's `regex` code source; every code it captures at a ref is one value of the part. */
    parts: z.record(z.string().regex(/^[A-Za-z0-9_-]+$/), name),
  })
  .superRefine((source, context) => {
    const used = new Set(getTemplateParts(source.template));
    if (used.size === 0) {
      context.addIssue({ code: "custom", path: ["template"], message: "must contain a {part} placeholder" });
    }
    for (const part of used) {
      if (!Object.hasOwn(source.parts, part)) {
        context.addIssue({ code: "custom", path: ["parts"], message: `placeholder {${part}} has no part` });
      }
    }
    for (const part of Object.keys(source.parts)) {
      if (!used.has(part)) {
        context.addIssue({ code: "custom", path: ["parts", part], message: "is not used in the template" });
      }
    }
  });

export type ComposedCodeSource = z.infer<typeof composedCodeSourceSchema>;

export const codeSourceSchema = z.union([regexCodeSourceSchema, composedCodeSourceSchema]);

export type CodeSource = z.infer<typeof codeSourceSchema>;

/** Every composed part must name a `regex` source declared in the same `codes` list. */
function checkComposedParts(codes: CodeSource[], context: z.RefinementCtx): void {
  const kinds = new Map(codes.map((source) => [source.name, source.kind]));
  for (const [position, source] of codes.entries()) {
    if (source.kind !== "composed") continue;
    for (const [part, partSource] of Object.entries(source.parts)) {
      const kind = kinds.get(partSource);
      if (kind === "regex") continue;
      context.addIssue({
        code: "custom",
        path: [position, "parts", part],
        message:
          kind === undefined
            ? `names "${partSource}", which is not a code source`
            : `names "${partSource}", a composed source; parts read regex sources only`,
      });
    }
  }
}

export const errorCodeClientSchema = z
  .strictObject({
    name,
    /** The live builds: refs, resolvers and selectors (see `refListSchema`). */
    refs: refListSchema,
    /** The client's translation map files, read at every client ref. */
    files: globs,
    /** Regex whose named group `code` captures one translated code. */
    pattern: z.string().min(1),
    flags,
    /** The `client-usage` clients whose calls are this client's; defaults to the one with the same name. */
    usage: z.array(name).min(1).optional(),
  })
  .superRefine(checkPattern);

export type ErrorCodeClient = z.infer<typeof errorCodeClientSchema>;

export const errorCodeAcceptSchema = z.strictObject({
  /** A code or a glob over codes (`Shop.*`). */
  code: z.string().min(1),
  /** Without it the entry accepts the code for every client. */
  client: name.optional(),
  reason: z.string().min(1),
});

export type ErrorCodeAccept = z.infer<typeof errorCodeAcceptSchema>;

/** One value or a non-empty list of them, read as a list. */
const oneOrMore = <T extends z.ZodType>(item: T) =>
  z.preprocess((value) => (typeof value === "string" ? [value] : value), z.array(item).min(1));

/** `METHOD /path/glob`; the method may be `*`. */
const operationGlob = z
  .string()
  .regex(/^(\*|[A-Za-z]+) \/\S*$/, 'use "METHOD /path/glob", for example "* /api/shop/**"');

export const returnedBySchema = z.strictObject({
  /** Codes or globs over codes (`Shop.*`) that only these operations return. */
  codes: oneOrMore(z.string().min(1)),
  /** Name of the `openapi` API, as `client-usage` clients name it. */
  api: z.string().min(1),
  operations: oneOrMore(operationGlob),
});

export type ReturnedBy = z.infer<typeof returnedBySchema>;

const uniqueNames = (entries: { name: string }[]) =>
  new Set(entries.map((entry) => entry.name)).size === entries.length;

export const errorCodesConfigSchema = z.strictObject({
  codes: z
    .array(codeSourceSchema)
    .min(1)
    .refine(uniqueNames, "code source names must be unique")
    .superRefine(checkComposedParts),
  clients: z.array(errorCodeClientSchema).min(1).refine(uniqueNames, "client names must be unique"),
  accept: z.array(errorCodeAcceptSchema).optional(),
  returnedBy: z.array(returnedBySchema).optional(),
});

export type ErrorCodesConfig = z.infer<typeof errorCodesConfigSchema>;
