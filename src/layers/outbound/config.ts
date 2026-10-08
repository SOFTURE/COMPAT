import { z } from "zod";

export const OUTBOUND_LAYER = "outbound";

export const OUTBOUND_FINDING_CLASSES = {
  "outbound-added": "needs-action",
  "outbound-removed": "safe",
} as const;

export type OutboundFindingId = keyof typeof OUTBOUND_FINDING_CLASSES;

/** Where a target's configuration key comes from besides a `key` group of the pattern. */
export const TARGET_KEY_SOURCES = ["appsettings"] as const;

const name = z.string().regex(/^[A-Za-z0-9._-]+$/, "use letters, digits, '.', '_' or '-'");

const FLAGS = /^[imsu]*$/;

const flags = z
  .string()
  .regex(FLAGS, "use only the flags i, m, s and u")
  .refine((value) => new Set(value).size === value.length, "must not repeat a flag")
  .default("");

/** The names of the named groups of a pattern; an empty alternative always matches, so every group is listed. */
export function getPatternGroups(pattern: string, patternFlags: string): Set<string> {
  return new Set(Object.keys(new RegExp(`(?:${pattern})|`, patternFlags).exec("")?.groups ?? {}));
}

/** Compiles a configured pattern with `g` and `d`, or returns why it cannot be used. */
export function compileTargetPattern(pattern: string, patternFlags: string): RegExp | { error: string } {
  let regex: RegExp;
  try {
    // `d` gives match indices, so evidence points at the line of the call, not the start of the match.
    regex = new RegExp(pattern, `${patternFlags}dg`);
  } catch (error) {
    return { error: `is not a valid regular expression: ${(error as Error).message}` };
  }
  const groups = getPatternGroups(pattern, patternFlags);
  if (!groups.has("host") && !groups.has("path")) {
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
    /** `appsettings`: the configuration path of the JSON leaf holding a capture (`Shop:BaseUrl`) is its key. */
    keyFrom: z.enum(TARGET_KEY_SOURCES).optional(),
    /** The compose service that runs the app; a target whose key its `environment` sets is reported as the key. */
    service: z.string().min(1).optional(),
    /**
     * Where `service` is looked up. Defaults to the files of the `config` layer's `compose` sources, so a local-dev
     * compose never counts as the deploy; to `DEFAULT_COMPOSE_FILES` only without one.
     */
    composeFiles: z.array(z.string().min(1)).min(1).optional(),
  })
  .superRefine((source, context) => {
    // A flags issue is already reported; compiling with them would only repeat it.
    if (!FLAGS.test(source.flags) || new Set(source.flags).size !== source.flags.length) return;
    const compiled = compileTargetPattern(source.pattern, source.flags);
    if ("error" in compiled) {
      context.addIssue({ code: "custom", path: ["pattern"], message: compiled.error });
      return;
    }
    const hasKey = source.keyFrom !== undefined || getPatternGroups(source.pattern, source.flags).has("key");
    if (hasKey && source.service === undefined) {
      context.addIssue({
        code: "custom",
        path: ["service"],
        message: "is required when targets carry a key (`keyFrom` or a (?<key>...) group)",
      });
    }
    if (!hasKey && source.service !== undefined) {
      context.addIssue({
        code: "custom",
        path: ["service"],
        message: "needs a key for each target: set `keyFrom` or add a named group (?<key>...) to `pattern`",
      });
    }
    if (source.keyFrom !== undefined && getPatternGroups(source.pattern, source.flags).has("key")) {
      context.addIssue({
        code: "custom",
        path: ["keyFrom"],
        message: "cannot be combined with a (?<key>...) group in `pattern`; use one of them",
      });
    }
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
