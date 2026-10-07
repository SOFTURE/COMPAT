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

/**
 * Declares a layer with a typed `run` and returns it in the registry's erased form. The cast is
 * sound because the core only calls `run` with a config that `configSchema` itself parsed.
 */
export function defineLayer<S extends z.ZodObject>(layer: Layer<S>): Layer {
  return layer as unknown as Layer;
}
