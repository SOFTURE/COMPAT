import { z } from "zod";

export const CLIENT_USAGE_LAYER = "client-usage";

const relativePath = z
  .string()
  .min(1)
  .refine((path) => !path.startsWith("/") && !/^[a-zA-Z]:[\\/]/.test(path), "must be a relative path")
  .refine((path) => !path.split(/[\\/]/).includes(".."), "must not contain '..'");

const gitRef = z
  .string()
  .min(1)
  .refine((ref) => !ref.startsWith("-"), "must not start with '-'");

export const clientRefsSchema = z.union([
  z.array(gitRef).min(1),
  z.strictObject({
    /** `git tag --list` pattern, for example `2.*`. */
    tags: gitRef,
    /** Lowest version to keep; tags without a version are dropped when it is set. */
    since: z.string().min(1).optional(),
  }),
]);

export type ClientRefs = z.infer<typeof clientRefsSchema>;

export const generatedClientSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("typescript"), path: relativePath }),
]);

export const clientSchema = z.strictObject({
  name: z.string().regex(/^[A-Za-z0-9._-]+$/, "use letters, digits, '.', '_' or '-'"),
  /** Name of the `openapi` API this client calls. */
  api: z.string().min(1),
  refs: clientRefsSchema,
  generatedClient: generatedClientSchema,
  /** Globs of the client's own code; when set, an operation counts as called only if its function is referenced there. */
  sources: z.array(z.string().min(1)).min(1).optional(),
});

export type ClientConfig = z.infer<typeof clientSchema>;

export const clientUsageConfigSchema = z.strictObject({
  clients: z
    .array(clientSchema)
    .min(1)
    .refine(
      (clients) => new Set(clients.map((client) => client.name)).size === clients.length,
      "client names must be unique",
    ),
});

export type ClientUsageConfig = z.infer<typeof clientUsageConfigSchema>;
