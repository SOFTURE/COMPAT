import { compareClass, type FindingClass, type LayerResult } from "./finding.js";

export const FAIL_ON_VALUES = ["breaking", "rollback-risk", "needs-action", "never"] as const;

export type FailOn = (typeof FAIL_ON_VALUES)[number];

/** `required` names layers that must have run; anything else about them fails the gate. */
export type GateOptions = { failOn: FailOn; allowIncomplete: boolean; required?: readonly string[] };

export const INACTIVE_STATUSES = ["disabled", "not-configured"] as const;

/** A known layer that did not run: `enabled: false` in the config, or missing from it. */
export type InactiveLayer = { layer: string; status: (typeof INACTIVE_STATUSES)[number] };

export type Gate = { passed: boolean; exitCode: 0 | 1; reasons: string[] };

export type LayerVerdict = FindingClass | "no-findings" | "skipped" | "failed";

export function getLayerVerdict(result: LayerResult): LayerVerdict {
  if (result.status !== "ran") return result.status;
  let highest: FindingClass | null = null;
  for (const finding of result.findings) {
    if (finding.accepted) continue;
    if (highest === null || compareClass(finding.class, highest) > 0) highest = finding.class;
  }
  return highest ?? "no-findings";
}

export function evaluateGate(
  results: LayerResult[],
  options: GateOptions,
  inactive: readonly InactiveLayer[] = [],
): Gate {
  const required = new Set(options.required ?? []);
  const reasons: string[] = [];
  for (const result of results) {
    if (result.status !== "skipped" && options.failOn !== "never") {
      const failing = result.findings.filter(
        (finding) => !finding.accepted && compareClass(finding.class, options.failOn as FindingClass) >= 0,
      );
      if (failing.length > 0) {
        reasons.push(`${result.layer}: ${failing.length} finding(s) at or above ${options.failOn}`);
      }
    }
    if (result.status === "ran") continue;
    if (required.has(result.layer)) {
      reasons.push(`${result.layer}: layer ${result.status}, but --require names it`);
    } else if (!options.allowIncomplete) {
      reasons.push(`${result.layer}: layer ${result.status}, so the check is incomplete`);
    }
  }
  for (const layer of inactive) {
    if (!required.has(layer.layer)) continue;
    const status = layer.status === "disabled" ? "disabled" : "not configured";
    reasons.push(`${layer.layer}: layer ${status}, but --require names it`);
  }
  const passed = reasons.length === 0;
  return { passed, exitCode: passed ? 0 : 1, reasons };
}
