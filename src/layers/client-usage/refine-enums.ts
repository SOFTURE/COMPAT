import type { Evidence, Exposure, Finding } from "../../model/finding.js";
import type { FindingRevision } from "../layer.js";
import { EXPOSED_ADDED_ID, PERSISTED_ENUMS_LAYER } from "../persisted-enums/persisted-enums-layer.js";
import { CLIENT_USAGE_LAYER } from "./config.js";
import type { BranchTarget } from "./find-enum-branches.js";
import { type ClientRefUsage, formatRefs, type RefineSummary, toEvidence } from "./refine.js";

const MAX_EVIDENCE = 10;

/** A source line of a client ref that branches on an exposed enum. */
export type BranchSite = { path: string; line: number };

/** The enum branch targets of one exposure: one per enum, with the property names its fields end in. */
export function toBranchTarget(enumName: string, exposure: Exposure): BranchTarget {
  const properties = exposure.fields.map((field) => (field.split(".").at(-1) as string).toLowerCase());
  return { enumName, properties: [...new Set(properties)].sort() };
}

export function getBranchKey(target: BranchTarget): string {
  return `${target.enumName}:${target.properties.join(",")}`;
}

/** The `enum-member-exposed-added` findings `client-usage` can refine, with their positions. */
export function findExposedFindings(findings: readonly Finding[]): { index: number; finding: Finding }[] {
  return findings.flatMap((finding, index) =>
    finding.layer === PERSISTED_ENUMS_LAYER &&
    finding.id === EXPOSED_ADDED_ID &&
    finding.exposure !== undefined &&
    finding.accepted === undefined &&
    finding.class !== "safe"
      ? [{ index, finding }]
      : [],
  );
}

type ExposureReads = {
  branching: { usage: ClientRefUsage; sites: BranchSite[] }[];
  /** Refs of a client without `sources`: they may branch, nothing proves otherwise. */
  unchecked: ClientRefUsage[];
  /** APIs no client is configured for. */
  uncovered: string[];
  read: ClientRefUsage[];
};

function readExposures(finding: Finding, usages: readonly ClientRefUsage[]): ExposureReads {
  const reads: ExposureReads = { branching: [], unchecked: [], uncovered: [], read: [] };
  for (const exposure of finding.exposure ?? []) {
    const apiUsages = usages.filter((usage) => usage.api === exposure.api);
    if (apiUsages.length === 0) {
      reads.uncovered.push(exposure.api);
      continue;
    }
    const key = getBranchKey(toBranchTarget(finding.scope, exposure));
    for (const usage of apiUsages) {
      const sites = usage.branches?.get(key);
      if (sites === undefined) reads.unchecked.push(usage);
      else if (sites.length > 0) reads.branching.push({ usage, sites });
      else reads.read.push(usage);
    }
  }
  return reads;
}

function describeFields(finding: Finding): string {
  return [...new Set((finding.exposure ?? []).flatMap((exposure) => exposure.fields))].join(", ");
}

function refineExposed(finding: Finding, usages: readonly ClientRefUsage[]): Finding | undefined {
  const reads = readExposures(finding, usages);
  const fields = describeFields(finding);
  if (reads.branching.length > 0) {
    const sites: Evidence[] = reads.branching.flatMap(({ usage, sites }) =>
      sites.map((site) => ({ ...toEvidence(usage, site.line), path: site.path })),
    );
    return {
      ...finding,
      message: `${finding.message}; ${formatRefs(reads.branching.map(({ usage }) => usage))} branch on ${fields} (client-usage)`,
      evidence: [...finding.evidence, ...sites.slice(0, MAX_EVIDENCE)],
    };
  }
  if (reads.read.length === 0 && reads.unchecked.length === 0) return undefined;
  if (reads.unchecked.length > 0 || reads.uncovered.length > 0) {
    const gaps = [
      ...(reads.unchecked.length > 0
        ? [`${formatRefs(reads.unchecked)} cannot be checked without "sources"`]
        : []),
      ...reads.uncovered.map((api) => `API "${api}" has no client configured`),
    ];
    return { ...finding, message: `${finding.message}; ${gaps.join("; ")} (client-usage)` };
  }
  return {
    ...finding,
    class: "safe",
    evidence: [...finding.evidence, ...reads.read.map((usage) => toEvidence(usage)).slice(0, MAX_EVIDENCE)],
    reclassified: {
      from: finding.class,
      by: CLIENT_USAGE_LAYER,
      reason: `no live client ref branches on ${fields}: ${formatRefs(reads.read)}`,
    },
  };
}

/**
 * Re-classifies the `enum-member-exposed-added` findings: when every live ref of every client of the
 * exposing APIs was scanned and none branches on the fields, the unknown value is harmless (`safe`);
 * a ref that branches keeps the class and adds its branch sites as evidence.
 */
export function refineExposedFindings(
  findings: readonly Finding[],
  usages: readonly ClientRefUsage[],
): RefineSummary {
  const summary: RefineSummary = { revisions: [], toSafe: 0, withEvidence: 0 };
  for (const { index, finding } of findExposedFindings(findings)) {
    const refined = refineExposed(finding, usages);
    if (refined === undefined) continue;
    summary.revisions.push({
      layer: PERSISTED_ENUMS_LAYER,
      index,
      finding: refined,
    } satisfies FindingRevision);
    if (refined.class === "safe") summary.toSafe++;
    else summary.withEvidence++;
  }
  return summary;
}
