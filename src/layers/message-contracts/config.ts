import { z } from "zod";
import { COMMENT_STYLES } from "../config/comments.js";
import { ENUM_STORAGES } from "../persisted-enums/compare-enums.js";
import { ENUM_CHANGE_IDS } from "../persisted-enums/config.js";

export const MESSAGE_CHANGE_IDS = [
  "message-added",
  "message-removed",
  "message-renamed",
  "message-entity-name-changed",
  "message-base-added",
  "message-base-removed",
  "message-property-added",
  "message-property-removed",
  "message-property-type-changed",
  "message-property-nullability-changed",
  "message-property-required",
  "queue-added",
  "queue-removed",
] as const;

export const MESSAGE_CONTRACT_FINDING_IDS = [...MESSAGE_CHANGE_IDS, ...ENUM_CHANGE_IDS] as const;

export type MessageContractFindingId = (typeof MESSAGE_CONTRACT_FINDING_IDS)[number];

const sourceName = z.string().regex(/^[A-Za-z0-9._-]+$/, "use letters, digits, '.', '_' or '-'");

const globs = z.union([z.string().min(1), z.array(z.string().min(1)).min(1)]);

/** Compiles a queue pattern, or returns why it cannot be used. */
export function compileQueuePattern(pattern: string, flags: string): { regex: RegExp } | { error: string } {
  let regex: RegExp;
  try {
    // `d` gives match indices, so evidence points at the line of the queue name.
    regex = new RegExp(pattern, `${flags}dg`);
  } catch (error) {
    return { error: `is not a valid regular expression: ${(error as Error).message}` };
  }
  // An empty alternative always matches, so the result has one entry per group of the pattern.
  const probe = new RegExp(`(?:${pattern})|`, flags).exec("");
  const hasQueueGroup = Object.hasOwn(probe?.groups ?? {}, "queue");
  if (!hasQueueGroup && (probe?.length ?? 1) < 2) {
    return { error: "must contain a named group (?<queue>...) or a capture group" };
  }
  return { regex };
}

export const contractSourceSchema = z.strictObject({
  name: sourceName,
  language: z.literal("csharp"),
  /** The `.cs` files of the contracts, for example a `*.Contract.*.Messages` project. */
  files: globs,
  /** How enums travel: MassTransit's System.Text.Json writes their names (`string`). */
  enumStorage: z.enum(ENUM_STORAGES).default("string"),
});

export type ContractSource = z.infer<typeof contractSourceSchema>;

export const regexQueueSourceSchema = z
  .strictObject({
    kind: z.literal("regex"),
    name: sourceName,
    files: globs,
    /** A pattern with a named group `queue`, or else a first capture group, for the queue name. */
    pattern: z.string().min(1),
    flags: z
      .string()
      .regex(/^[imsu]*$/, "use only the flags i, m, s and u")
      .refine((flags) => new Set(flags).size === flags.length, "must not repeat a flag")
      .default(""),
    comments: z.enum(COMMENT_STYLES).default("slash"),
    /** `false` for a source that only feeds a `composed` source: scanned and checked, never reported. */
    report: z.boolean().default(true),
  })
  .superRefine((source, context) => {
    if (!/^[imsu]*$/.test(source.flags) || new Set(source.flags).size !== source.flags.length) return;
    const compiled = compileQueuePattern(source.pattern, source.flags);
    if ("error" in compiled) context.addIssue({ code: "custom", path: ["pattern"], message: compiled.error });
  });

export type RegexQueueSource = z.infer<typeof regexQueueSourceSchema>;

const PLACEHOLDER = /\{([A-Za-z0-9_-]+)\}/g;

/** The placeholder names of a composed template, in order of appearance. */
export function getTemplateParts(template: string): string[] {
  return [...template.matchAll(PLACEHOLDER)].map((match) => match[1] as string);
}

const composedPartSchema = z.union([
  sourceName,
  z
    .strictObject({
      /** The queue source whose names fill the part. */
      source: sourceName.optional(),
      /** The value when the source finds nothing at a ref, or the constant value without a source. */
      default: z.string().optional(),
    })
    .refine((part) => part.source !== undefined || part.default !== undefined, "set source, default or both"),
]);

export type ComposedPart = z.infer<typeof composedPartSchema>;

export const composedQueueSourceSchema = z
  .strictObject({
    kind: z.literal("composed"),
    name: sourceName,
    /** The queue name with `{part}` placeholders, for example `{endpoint}{separator}{group}`. */
    template: z.string().min(1),
    parts: z.record(z.string().regex(/^[A-Za-z0-9_-]+$/), composedPartSchema),
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
    const hasSource = Object.values(source.parts).some(
      (part) => typeof part === "string" || part.source !== undefined,
    );
    if (!hasSource) {
      context.addIssue({ code: "custom", path: ["parts"], message: "at least one part must name a source" });
    }
  });

export type ComposedQueueSource = z.infer<typeof composedQueueSourceSchema>;

export const queueSourceSchema = z.discriminatedUnion("kind", [
  regexQueueSourceSchema,
  composedQueueSourceSchema,
]);

export type QueueSource = z.infer<typeof queueSourceSchema>;

export const acceptEntrySchema = z.strictObject({
  id: z.enum(MESSAGE_CONTRACT_FINDING_IDS),
  /** The finding subject exactly as reported, for example `Ns.OrderPlaced.Total` or a queue name. */
  subject: z.string().min(1),
  reason: z.string().min(1),
});

export type AcceptEntry = z.infer<typeof acceptEntrySchema>;

const hasUniqueNames = (entries: { name: string }[]) =>
  new Set(entries.map((entry) => entry.name)).size === entries.length;

/** The source a composed part reads, if any. */
export function getPartSource(part: ComposedPart): string | undefined {
  return typeof part === "string" ? part : part.source;
}

/** Every composed part must read a `regex` source declared in the same `queues` list. */
function checkComposedParts(queues: QueueSource[], context: z.RefinementCtx): void {
  const kinds = new Map(queues.map((queue) => [queue.name, queue.kind]));
  for (const [position, queue] of queues.entries()) {
    if (queue.kind !== "composed") continue;
    for (const [name, part] of Object.entries(queue.parts)) {
      const source = getPartSource(part);
      if (source === undefined) continue;
      const kind = kinds.get(source);
      if (kind === "regex") continue;
      context.addIssue({
        code: "custom",
        path: [position, "parts", name],
        message:
          kind === undefined
            ? `names "${source}", which is not a queue source`
            : `names "${source}", a composed source; parts read regex sources only`,
      });
    }
  }
}

export const messageContractsConfigSchema = z.strictObject({
  sources: z.array(contractSourceSchema).min(1).refine(hasUniqueNames, "source names must be unique"),
  queues: z
    .array(queueSourceSchema)
    .refine(hasUniqueNames, "queue source names must be unique")
    .superRefine(checkComposedParts)
    .optional(),
  accept: z.array(acceptEntrySchema).optional(),
});

export type MessageContractsConfig = z.infer<typeof messageContractsConfigSchema>;
