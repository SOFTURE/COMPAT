import { z } from "zod";

const RESERVED_OASDIFF_ARGS = ["--format", "-f", "--fail-on", "-o"];

const relativePath = z
  .string()
  .min(1)
  .refine((path) => !path.startsWith("/") && !/^[a-zA-Z]:[\\/]/.test(path), "must be a relative path")
  .refine((path) => !path.split(/[\\/]/).includes(".."), "must not contain '..'");

const httpUrl = z.url({ protocol: /^https?$/ });

export const specSourceSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("file"), path: relativePath }),
  z.strictObject({
    kind: z.literal("command"),
    run: z.string().min(1),
    output: relativePath,
    timeoutSeconds: z.number().int().positive().max(7200).optional(),
  }),
  z.strictObject({ kind: z.literal("url"), base: httpUrl, revision: httpUrl }),
]);

export type SpecSource = z.infer<typeof specSourceSchema>;

export const acceptEntrySchema = z.strictObject({
  /** oasdiff check id, for example `request-property-became-not-nullable`. */
  id: z.string().min(1),
  /** `METHOD /path` as oasdiff reports it; required to accept a change that belongs to an operation. */
  operation: z
    .string()
    .regex(/^[A-Z]+ \/\S*$/, "must look like 'POST /api/pets/{petId}'")
    .optional(),
  reason: z.string().min(1),
});

export type AcceptEntry = z.infer<typeof acceptEntrySchema>;

export const apiSchema = z.strictObject({
  name: z.string().regex(/^[A-Za-z0-9._-]+$/, "use letters, digits, '.', '_' or '-'"),
  source: specSourceSchema,
  accept: z.array(acceptEntrySchema).optional(),
});

export const openapiConfigSchema = z.strictObject({
  apis: z
    .array(apiSchema)
    .min(1)
    .refine((apis) => new Set(apis.map((api) => api.name)).size === apis.length, "API names must be unique"),
  oasdiff: z
    .strictObject({
      path: z.string().min(1).optional(),
      /** Download the pinned oasdiff release when none is configured or on PATH (default true). */
      download: z.boolean().optional(),
      args: z
        .array(z.string())
        .refine(
          (args) => !args.some((arg) => RESERVED_OASDIFF_ARGS.includes(arg.split("=")[0] as string)),
          `must not set ${RESERVED_OASDIFF_ARGS.join(", ")}`,
        )
        .optional(),
    })
    .optional(),
});

export type OpenapiConfig = z.infer<typeof openapiConfigSchema>;
export type ApiConfig = z.infer<typeof apiSchema>;
