import type { LayerResult } from "../model/finding.js";
import type { FailOn, Gate, InactiveLayer } from "../model/gate.js";

/** Where a ref was set: `--base`/`--revision` on the command line, or `check` in the config. */
export type RefSource = "flag" | "config";

/** `resolver` is the base or revision value when a resolver (e.g. `github-deployment:prod`) chose `ref`. */
export type RefInfo = { ref: string; commit: string; resolver?: string; source: RefSource };

export type Report = {
  base: RefInfo;
  revision: RefInfo;
  failOn: FailOn;
  allowIncomplete: boolean;
  /** Layers named by `--require`. */
  required: string[];
  gate: Gate;
  layers: LayerResult[];
  /** Known layers that did not run; they are listed so a pass never hides an unchecked contract. */
  inactive: InactiveLayer[];
};
