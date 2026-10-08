import type { z } from "zod";
import type { RefTree } from "../git/ref-tree.js";
import type { Finding, LayerResult } from "../model/finding.js";
import type { FetchFn } from "../resolve/github.js";

export type LayerContext<C> = {
  config: C;
  base: RefTree;
  revision: RefTree;
  repoDir: string;
  /** A directory owned by this layer for the current run; removed afterwards. */
  tempDir: string;
  /**
   * A directory owned by this layer for files that must outlive the run, such as the full output of the commands it
   * ran; created on first use. Absent when the caller keeps no logs.
   */
  logDir?: string;
  env: NodeJS.ProcessEnv;
  /** `fetch` for the GitHub resolvers; tests inject a mock here, the CLI leaves it unset. */
  fetch?: FetchFn;
  log(message: string): void;
  /** Results of the layers that ran before this one, in registry order; absent when run on its own. */
  results?: readonly LayerResult[];
  /** What live client refs call, shared by `client-usage` when it ran before this layer. */
  calls?: readonly ClientRefCalls[];
  /**
   * The globs of the `config` layer's `compose` sources, which are the deploy; absent when that layer is not enabled
   * or has no `compose` source.
   */
  deployComposeFiles?: readonly string[];
};

/** The operations one live client ref calls: method lower-case or `*` when unknown, path normalized. */
export type ClientRefCalls = {
  client: string;
  api: string;
  ref: string;
  operations: { method: string; path: string }[];
};

/** Replaces finding `index` of the earlier layer `layer`; only class, message, evidence, `reclassified` and `reclassifyAttempt` may change. */
export type FindingRevision = { layer: string; index: number; finding: Finding };

/**
 * A layer's own result plus, for a layer that refines earlier ones, the findings it revised, and the
 * client calls it read for the layers after it. Neither reaches the report.
 */
export type LayerOutput = LayerResult & { revisions?: FindingRevision[]; calls?: ClientRefCalls[] };

/**
 * A layer compares one aspect of the two refs. Its config schema must be built with
 * `z.strictObject` so typos fail instead of being silently dropped.
 */
export type Layer<S extends z.ZodObject = z.ZodObject> = {
  name: string;
  description: string;
  configSchema: S;
  run(context: LayerContext<z.infer<S>>): Promise<LayerOutput>;
};

/**
 * Declares a layer with a typed `run` and returns it in the registry's erased form. The cast is
 * sound because the core only calls `run` with a config that `configSchema` itself parsed.
 */
export function defineLayer<S extends z.ZodObject>(layer: Layer<S>): Layer {
  return layer as unknown as Layer;
}
