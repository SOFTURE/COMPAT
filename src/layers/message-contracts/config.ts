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

export const queueSourceSchema = z
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
  })
  .superRefine((source, context) => {
    if (!/^[imsu]*$/.test(source.flags) || new Set(source.flags).size !== source.flags.length) return;
    const compiled = compileQueuePattern(source.pattern, source.flags);
    if ("error" in compiled) context.addIssue({ code: "custom", path: ["pattern"], message: compiled.error });
  });

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

export const messageContractsConfigSchema = z.strictObject({
  sources: z.array(contractSourceSchema).min(1).refine(hasUniqueNames, "source names must be unique"),
  queues: z.array(queueSourceSchema).refine(hasUniqueNames, "queue source names must be unique").optional(),
  accept: z.array(acceptEntrySchema).optional(),
});

export type MessageContractsConfig = z.infer<typeof messageContractsConfigSchema>;
