import { z } from "zod";

const RESERVED_OASDIFF_ARGS = ["--format", "-f", "--fail-on", "-o"];

const relativePath = z
  .string()
  .min(1)
  .refine((path) => !path.startsWith("/") && !/^[a-zA-Z]:[\\/]/.test(path), "must be a relative path")
  .refine((path) => !path.split(/[\\/]/).includes(".."), "must not contain '..'");

const httpUrl = z.url({ protocol: /^https?$/ });

const timeoutSeconds = z.number().int().positive().max(7200);

/** The placeholder replaced by the free port picked for each side of a `serve` source. */
export const PORT_PLACEHOLDER = "{port}";

const isHttpUrl = (value: string): boolean => {
  try {
    return ["http:", "https:"].includes(new URL(value).protocol);
  } catch {
    return false;
  }
};

/** An http(s) URL that may contain `{port}`. */
const portUrl = z
  .string()
  .refine(
    (url) => isHttpUrl(url.replaceAll(PORT_PLACEHOLDER, "1")),
    "must be an http(s) URL; '{port}' is allowed",
  );

const serveSourceSchema = z.strictObject({
  kind: z.literal("serve"),
  /** Shell command that starts the app and keeps running. */
  run: z.string().min(1),
  /** Where the running app serves the spec. */
  url: portUrl,
  /** Polled until 2xx before `url`, for example a health check. */
  ready: portUrl.optional(),
  env: z
    .record(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/, "must be an environment variable name"), z.string())
    .optional(),
  /** Sent with every request; `${VAR}` reads the environment. Values are never printed. */
  headers: z.record(z.string().min(1), z.string()).optional(),
  /** From the start of the app until the spec is fetched. */
  timeoutSeconds: timeoutSeconds.optional(),
});

export const specSourceSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("file"), path: relativePath }),
  z.strictObject({
    kind: z.literal("command"),
    run: z.string().min(1),
    output: relativePath,
    timeoutSeconds: timeoutSeconds.optional(),
  }),
  z.strictObject({ kind: z.literal("url"), base: httpUrl, revision: httpUrl }),
  serveSourceSchema,
]);

export type SpecSource = z.infer<typeof specSourceSchema>;
export type ServeSource = z.infer<typeof serveSourceSchema>;

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

/** Runs once per side, in the materialized ref, before any spec source of that side. */
export const setupSchema = z.strictObject({
  run: z.string().min(1),
  timeoutSeconds: timeoutSeconds.optional(),
});

export type SetupCommand = z.infer<typeof setupSchema>;

export const openapiConfigSchema = z.strictObject({
  setup: setupSchema.optional(),
  /** How many sides (base, revision) are prepared at once: 2 (default) in parallel, 1 one after the other. */
  concurrency: z.number().int().min(1).max(2).optional(),
  apis: z
    .array(apiSchema)
    .min(1)
    .refine((apis) => new Set(apis.map((api) => api.name)).size === apis.length, "API names must be unique"),
  oasdiff: z
    .strictObject({
      path: z.string().min(1).optional(),
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
