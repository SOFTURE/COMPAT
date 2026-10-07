import type { z } from "zod";
import type { RefTree } from "../git/ref-tree.js";
import type { LayerResult } from "../model/finding.js";

export type LayerContext<C> = {
  config: C;
  base: RefTree;
  revision: RefTree;
  repoDir: string;
  /** A directory owned by this layer for the current run; removed afterwards. */
  tempDir: string;
  env: NodeJS.ProcessEnv;
  log(message: string): void;
};

/**
 * A layer compares one aspect of the two refs. Its config schema must be built with
 * `z.strictObject` so typos fail instead of being silently dropped.
 */
export type Layer<S extends z.ZodObject = z.ZodObject> = {
  name: string;
  description: string;
  configSchema: S;
  run(context: LayerContext<z.infer<S>>): Promise<LayerResult>;
};

/** Keeps the schema type when declaring a layer. */
export function defineLayer<S extends z.ZodObject>(layer: Layer<S>): Layer<S> {
  return layer;
}
