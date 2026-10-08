import { z } from "zod";

export const RESULTS_KINDS = ["junit", "trx"] as const;

export type ResultsKind = (typeof RESULTS_KINDS)[number];

export const BEHAVIOUR_FINDING_IDS = ["base-test-failed"] as const;

/** Stands for the free port of the stack run in `run` and `ready`. */
export const PORT_PLACEHOLDER = "{port}";

export const DEFAULT_START_TIMEOUT_SECONDS = 1800;
export const DEFAULT_TEST_TIMEOUT_SECONDS = 3600;
export const DEFAULT_STOP_TIMEOUT_SECONDS = 600;
export const DEFAULT_COLLECT_TIMEOUT_SECONDS = 300;
const MAX_TIMEOUT_SECONDS = 86_400;
const MAX_RETRIES = 5;

const side = z.enum(["base", "revision"]);
const timeoutSeconds = z.number().int().positive().max(MAX_TIMEOUT_SECONDS);
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

const globs = z.union([z.string().min(1), z.array(z.string().min(1)).min(1)]);

export const startCommandSchema = z
  .strictObject({
    side: side.default("revision"),
    run: z.string().min(1),
    /** A long-running app the layer keeps alive during the tests and stops afterwards. */
    background: z.boolean().default(false),
    /** A URL polled until it answers 2xx before the tests start; needs `background`. */
    ready: portUrl.optional(),
    timeoutSeconds: timeoutSeconds.default(DEFAULT_START_TIMEOUT_SECONDS),
  })
  .refine((start) => start.ready === undefined || start.background, {
    path: ["ready"],
    message: "needs background: true (a script that exits is done when it exits)",
  });

export type StartCommand = z.infer<typeof startCommandSchema>;

export const testCommandSchema = z.strictObject({
  side: side.default("base"),
  run: z.string().min(1),
  results: z.strictObject({
    kind: z.enum(RESULTS_KINDS),
    /** Result files, relative to the root of the test side's tree. */
    path: globs,
  }),
  timeoutSeconds: timeoutSeconds.default(DEFAULT_TEST_TIMEOUT_SECONDS),
});

export type TestCommand = z.infer<typeof testCommandSchema>;

export const stopCommandSchema = z.strictObject({
  side: side.default("revision"),
  run: z.string().min(1),
  timeoutSeconds: timeoutSeconds.default(DEFAULT_STOP_TIMEOUT_SECONDS),
});

export type StopCommand = z.infer<typeof stopCommandSchema>;

/**
 * Runs after a failed `start` or `test` and before `stop`, so what only the running stack holds (container logs)
 * survives the teardown; its output is saved next to the other command logs.
 */
export const collectCommandSchema = z.strictObject({
  /** Defaults to the side `stop` runs at in that cycle. */
  side: side.optional(),
  run: z.string().min(1),
  timeoutSeconds: timeoutSeconds.default(DEFAULT_COLLECT_TIMEOUT_SECONDS),
});

export type CollectCommand = z.infer<typeof collectCommandSchema>;

export const acceptEntrySchema = z.strictObject({
  /** The full test name; `*` matches any run of characters. */
  test: z.string().min(1),
  reason: z.string().min(1),
});

export type AcceptEntry = z.infer<typeof acceptEntrySchema>;

export const behaviourConfigSchema = z.strictObject({
  start: startCommandSchema.optional(),
  test: testCommandSchema,
  stop: stopCommandSchema.optional(),
  collect: collectCommandSchema.optional(),
  /** How many times the test command reruns while tests fail. */
  retries: z.number().int().min(0).max(MAX_RETRIES).default(0),
  /** Runs the tests against the test side's own stack first and drops tests that fail there. */
  baseline: z.boolean().default(false),
  accept: z.array(acceptEntrySchema).optional(),
});

export type BehaviourConfig = z.infer<typeof behaviourConfigSchema>;

/** Whether a full test name matches an accept pattern, where `*` matches any run of characters. */
export function matchesTestPattern(name: string, pattern: string): boolean {
  const source = pattern
    .split("*")
    .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join(".*");
  return new RegExp(`^${source}$`).test(name);
}
