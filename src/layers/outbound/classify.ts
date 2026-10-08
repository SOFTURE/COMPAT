import { matchesGlob } from "../../git/glob.js";
import type { Evidence, Finding } from "../../model/finding.js";
import {
  OUTBOUND_FINDING_CLASSES,
  OUTBOUND_LAYER,
  type OutboundAccept,
  type OutboundFindingId,
} from "./config.js";

/** Where a target is called: the target source that captured it first and its first line. */
export type TargetDeclaration = { source: string; evidence: Evidence };

/** Targets of one side, by normalized target. */
export type TargetSet = ReadonlyMap<string, TargetDeclaration>;

function createFinding(
  id: OutboundFindingId,
  target: string,
  declaration: TargetDeclaration,
  message: string,
): Finding {
  return {
    layer: OUTBOUND_LAYER,
    id,
    class: OUTBOUND_FINDING_CLASSES[id],
    scope: declaration.source,
    subject: target,
    message,
    evidence: [declaration.evidence],
  };
}

/** One `outbound-added` per target called only in the revision and one `outbound-removed` per target called only at the base. */
export function classifyOutbound(base: TargetSet, revision: TargetSet): Finding[] {
  const added = [...revision.keys()].filter((target) => !base.has(target)).sort();
  const removed = [...base.keys()].filter((target) => !revision.has(target)).sort();
  return [
    ...added.map((target) =>
      createFinding(
        "outbound-added",
        target,
        revision.get(target) as TargetDeclaration,
        `outbound call to ${target} is new in the revision; check that production allows it (API enabled for the credential, key restrictions, quotas, egress rules)`,
      ),
    ),
    ...removed.map((target) =>
      createFinding(
        "outbound-removed",
        target,
        base.get(target) as TargetDeclaration,
        `outbound call to ${target} is no longer made in the revision`,
      ),
    ),
  ];
}

/** Marks the `outbound-added` findings an entry accepts (its target may be a glob) and notes each entry's use. */
export function applyOutboundAccept(
  findings: Finding[],
  accept: readonly OutboundAccept[],
): { findings: Finding[]; notes: string[] } {
  const counts = accept.map(() => 0);
  const result = findings.map((finding) => {
    if (finding.id !== "outbound-added") return finding;
    const position = accept.findIndex((entry) => matchesGlob(finding.subject, entry.target));
    if (position === -1) return finding;
    counts[position] = (counts[position] ?? 0) + 1;
    return { ...finding, accepted: { reason: (accept[position] as OutboundAccept).reason } };
  });
  const notes = accept.map((entry, position) => {
    const count = counts[position] ?? 0;
    return count === 0
      ? `accept entry ${entry.target} matched nothing; remove it once the release that needed it is live`
      : `accept entry ${entry.target} accepted ${count} finding(s)`;
  });
  return { findings: result, notes };
}
