import { z } from "zod";
import { refListSchema } from "../../resolve/ref-list.js";

export const CLIENT_USAGE_LAYER = "client-usage";

const relativePath = z
  .string()
  .min(1)
  .refine((path) => !path.startsWith("/") && !/^[a-zA-Z]:[\\/]/.test(path), "must be a relative path")
  .refine((path) => !path.split(/[\\/]/).includes(".."), "must not contain '..'");

export const generatedClientSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("typescript"), path: relativePath }),
]);

export const clientSchema = z.strictObject({
  name: z.string().regex(/^[A-Za-z0-9._-]+$/, "use letters, digits, '.', '_' or '-'"),
  /** Name of the `openapi` API this client calls. */
  api: z.string().min(1),
  /** The live builds: refs, resolvers and selectors (see `refListSchema`). */
  refs: refListSchema,
  generatedClient: generatedClientSchema,
  /** Globs of the client's own code; when set, an operation counts as called only if its function is referenced there. */
  sources: z.array(z.string().min(1)).min(1).optional(),
  /** `"revision"` for a client deployed with the server: after the deploy only stale tabs run the `refs` builds. */
  deployedWith: z.literal("revision").optional(),
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
