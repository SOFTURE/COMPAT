import { z } from "zod";

export const OUTBOUND_LAYER = "outbound";

export const OUTBOUND_FINDING_CLASSES = {
  "outbound-added": "needs-action",
  "outbound-removed": "safe",
} as const;

export type OutboundFindingId = keyof typeof OUTBOUND_FINDING_CLASSES;

const name = z.string().regex(/^[A-Za-z0-9._-]+$/, "use letters, digits, '.', '_' or '-'");

const FLAGS = /^[imsu]*$/;

const flags = z
  .string()
  .regex(FLAGS, "use only the flags i, m, s and u")
  .refine((value) => new Set(value).size === value.length, "must not repeat a flag")
  .default("");

/** Compiles a configured pattern with `g` and `d`, or returns why it cannot be used. */
export function compileTargetPattern(pattern: string, patternFlags: string): RegExp | { error: string } {
  let regex: RegExp;
  try {
    // `d` gives match indices, so evidence points at the line of the call, not the start of the match.
    regex = new RegExp(pattern, `${patternFlags}dg`);
  } catch (error) {
    return { error: `is not a valid regular expression: ${(error as Error).message}` };
  }
  // An empty alternative always matches, so `groups` lists every named group of the pattern.
  const groups = new RegExp(`(?:${pattern})|`, patternFlags).exec("")?.groups ?? {};
  if (!("host" in groups) && !("path" in groups)) {
    return { error: "must contain a named group (?<host>...) or (?<path>...)" };
  }
  return regex;
}

export const targetSourceSchema = z
  .strictObject({
    name,
    /** Files that declare outbound targets, read at the base and the revision. */
    files: z.array(z.string().min(1)).min(1),
    /** Regex whose named groups `host` and `path` capture one target; at least one of them. */
    pattern: z.string().min(1),
    flags,
    /** Host and base path for matches without a `host` capture, for example `maps.googleapis.com/maps/api`. */
    host: z.string().min(1).optional(),
  })
  .superRefine((source, context) => {
    // A flags issue is already reported; compiling with them would only repeat it.
    if (!FLAGS.test(source.flags) || new Set(source.flags).size !== source.flags.length) return;
    const compiled = compileTargetPattern(source.pattern, source.flags);
    if ("error" in compiled) context.addIssue({ code: "custom", path: ["pattern"], message: compiled.error });
  });

export type TargetSource = z.infer<typeof targetSourceSchema>;

export const outboundAcceptSchema = z.strictObject({
  /** A target or a glob over targets (`maps.googleapis.com/maps/api/**`). */
  target: z.string().min(1),
  reason: z.string().min(1),
});

export type OutboundAccept = z.infer<typeof outboundAcceptSchema>;

export const outboundConfigSchema = z.strictObject({
  targets: z
    .array(targetSourceSchema)
    .min(1)
    .refine(
      (sources) => new Set(sources.map((source) => source.name)).size === sources.length,
      "target source names must be unique",
    ),
  accept: z.array(outboundAcceptSchema).optional(),
});

export type OutboundConfig = z.infer<typeof outboundConfigSchema>;
