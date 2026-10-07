import { z } from "zod";
import { ENUM_STORAGES, MEMBER_CHANGE_IDS } from "./compare-enums.js";

export const ENUM_CHANGE_IDS = [...MEMBER_CHANGE_IDS, "enum-added", "enum-removed"] as const;

export type EnumChangeId = (typeof ENUM_CHANGE_IDS)[number];

/** Finding ids of the persisted-enums layer: the shared enum changes plus the client-side one. */
export const PERSISTED_ENUM_FINDING_IDS = [...ENUM_CHANGE_IDS, "enum-member-exposed-added"] as const;

export type PersistedEnumFindingId = (typeof PERSISTED_ENUM_FINDING_IDS)[number];

const identifier = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/, "must be a C# or TypeScript identifier");

const relativePath = z
  .string()
  .min(1)
  .refine((path) => !path.startsWith("/") && !/^[a-zA-Z]:[\\/]/.test(path), "must be a relative path")
  .refine((path) => !path.split(/[\\/]/).includes(".."), "must not contain '..'");

const globs = z.union([z.string().min(1), z.array(z.string().min(1)).min(1)]);

const storage = z.enum(ENUM_STORAGES);

/** `NotificationDto.type`: a DTO type and the property through which the enum reaches clients. */
const exposedField = z
  .string()
  .regex(
    /^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_$][A-Za-z0-9_$]*)+$/,
    "must be Type.property, for example NotificationDto.type",
  );

export const exposureSchema = z.strictObject({
  /** Name of the API (as in `openapi` and `client-usage`) whose DTOs carry the enum. */
  api: z.string().min(1),
  fields: z.array(exposedField).min(1),
});

const discoveryPattern = z.string().superRefine((pattern, context) => {
  let compiled: RegExp;
  try {
    compiled = new RegExp(pattern);
  } catch (error) {
    context.addIssue({
      code: "custom",
      message: `is not a valid regular expression: ${(error as Error).message}`,
    });
    return;
  }
  // A regex with N groups matches the empty string with N + 1 entries; it needs at least one group.
  const groupCount = (new RegExp(`${compiled.source}|`).exec("")?.length ?? 1) - 1;
  if (groupCount < 1)
    context.addIssue({ code: "custom", message: "must have a capture group for the enum name" });
});

export const enumEntrySchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("named"),
    name: identifier,
    storage,
    /** Pins the declaration when several files declare an enum with this name. */
    file: relativePath.optional(),
    /** DTO fields that send the enum to clients as a plain string. */
    exposed: z.array(exposureSchema).min(1).optional(),
  }),
  z.strictObject({
    kind: z.literal("discover"),
    /** Files to search, for example the DbContext. */
    files: globs,
    /** Regex whose named group `name`, or else first group, captures the enum name. */
    pattern: discoveryPattern,
    storage,
  }),
]);

export type EnumEntry = z.infer<typeof enumEntrySchema>;

export const acceptEntrySchema = z.strictObject({
  id: z.enum(PERSISTED_ENUM_FINDING_IDS),
  enum: identifier,
  /** A member name at either ref; without it the entry matches only enum-level findings. */
  member: z.string().min(1).optional(),
  reason: z.string().min(1),
});

export type AcceptEntry = z.infer<typeof acceptEntrySchema>;

export const persistedEnumsConfigSchema = z.strictObject({
  /** Files that declare the enums: `.cs`, `.ts`, `.tsx`, `.mts`, `.cts`. */
  sources: globs,
  enums: z
    .array(enumEntrySchema)
    .min(1)
    .refine((entries) => {
      const names = entries.flatMap((entry) => (entry.kind === "named" ? [entry.name] : []));
      return new Set(names).size === names.length;
    }, "named enums must be unique"),
  accept: z.array(acceptEntrySchema).optional(),
});

export type PersistedEnumsConfig = z.infer<typeof persistedEnumsConfigSchema>;
