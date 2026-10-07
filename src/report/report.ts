import type { LayerResult } from "../model/finding.js";
import type { FailOn, Gate, InactiveLayer } from "../model/gate.js";

/** `resolver` is the `--base`/`--revision` value when a resolver (e.g. `github-deployment:prod`) chose `ref`. */
export type RefInfo = { ref: string; commit: string; resolver?: string };

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
