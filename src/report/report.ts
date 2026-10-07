import type { LayerResult } from "../model/finding.js";
import type { FailOn, Gate } from "../model/gate.js";

export type RefInfo = { ref: string; commit: string };

export type Report = {
  base: RefInfo;
  revision: RefInfo;
  failOn: FailOn;
  allowIncomplete: boolean;
  gate: Gate;
  layers: LayerResult[];
};
