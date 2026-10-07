import { compareClass, type FindingClass, type LayerResult } from "./finding.js";

export const FAIL_ON_VALUES = ["breaking", "rollback-risk", "needs-action", "never"] as const;

export type FailOn = (typeof FAIL_ON_VALUES)[number];

export type GateOptions = { failOn: FailOn; allowIncomplete: boolean };

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

export function evaluateGate(results: LayerResult[], options: GateOptions): Gate {
  const reasons: string[] = [];
  for (const result of results) {
    if (result.status === "ran") {
      if (options.failOn === "never") continue;
      const failing = result.findings.filter(
        (finding) => !finding.accepted && compareClass(finding.class, options.failOn as FindingClass) >= 0,
      );
      if (failing.length > 0) {
        reasons.push(`${result.layer}: ${failing.length} finding(s) at or above ${options.failOn}`);
      }
      continue;
    }
    if (options.allowIncomplete) continue;
    reasons.push(`${result.layer}: layer ${result.status}, so the check is incomplete`);
  }
  const passed = reasons.length === 0;
  return { passed, exitCode: passed ? 0 : 1, reasons };
}
