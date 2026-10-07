import type { LayerResult } from "../model/finding.js";
import type { FailOn, Gate } from "../model/gate.js";

/** `resolver` is the `--base`/`--revision` value when a resolver (e.g. `github-deployment:prod`) chose `ref`. */
export type RefInfo = { ref: string; commit: string; resolver?: string };

export type Report = {
  base: RefInfo;
  revision: RefInfo;
  failOn: FailOn;
  allowIncomplete: boolean;
  gate: Gate;
  layers: LayerResult[];
};
