import type { Evidence, Finding } from "../../model/finding.js";
import type { FindingRevision } from "../layer.js";
import { OPENAPI_LAYER } from "../openapi/classify.js";
import { CLIENT_USAGE_LAYER } from "./config.js";
import { parseOperation } from "./paths.js";
import {
  type Call,
  type ClientRefUsage,
  capEvidence,
  findAlwaysSent,
  findCalls,
  findFirstStop,
  formatRefs,
  readPropertyPath,
  toEvidence,
} from "./refine.js";

/**
 * Request widenings oasdiff reports as `info` going forward. In reverse (revision spec to base spec)
 * each one is an error: after a rollback the base server gets requests it does not accept from
 * clients built from the revision. The value is what clears a call: the property is always sent
 * (`required`), always sent non-null (`not-nullable`), or nothing can (`called`).
 */
export const ROLLBACK_RULES: Record<string, "required" | "not-nullable" | "called"> = {
  "request-property-became-nullable": "not-nullable",
  "request-property-became-optional": "required",
  "request-body-became-nullable": "called",
  "request-body-became-optional": "called",
  "request-parameter-became-nullable": "called",
  "request-parameter-became-optional": "called",
  "request-parameter-property-became-nullable": "called",
  "request-property-enum-value-added": "called",
  "request-parameter-enum-value-added": "called",
  "request-parameter-property-enum-value-added": "called",
};

const VALUE_TYPE_NOTE =
  "; where the base type is a non-nullable value type (number, boolean) the base server binds a missing value to its default (0, false) instead of rejecting it";

/** Whether the finding is a forward-safe request widening a revision build could exercise after a rollback. */
export function isRollbackCandidate(finding: Finding): boolean {
  return (
    finding.layer === OPENAPI_LAYER &&
    finding.class === "safe" &&
    finding.accepted === undefined &&
    finding.reclassified === undefined &&
    ROLLBACK_RULES[finding.id] !== undefined
  );
}

function refineRollbackFinding(finding: Finding, usages: readonly ClientRefUsage[]): Finding | undefined {
  const rule = ROLLBACK_RULES[finding.id];
  const operation = parseOperation(finding.subject);
  if (rule === undefined || operation === undefined) return undefined;
  const calls: Call[] = usages
    .map((usage) => ({ usage, operations: findCalls(usage, operation.method, operation.path) }))
    .filter((call) => call.operations.length > 0);
  if (calls.length === 0) return undefined;

  let risky = calls;
  let what = "these requests";
  let note = "";
  let stoppedAt: Evidence | undefined;
  if (rule !== "called") {
    const propertyPath = readPropertyPath(finding.message);
    if (propertyPath !== undefined) {
      const sent = calls.map((call) => ({
        call,
        proofs: call.operations.map((item) => findAlwaysSent(call.usage, item, propertyPath, rule)),
      }));
      const omitting = sent.filter(({ proofs }) => proofs.some((proof) => !proof.ok));
      if (omitting.length === 0) return undefined;
      risky = omitting.map(({ call }) => call);
      const property = propertyPath.join("/");
      what = rule === "required" ? `requests without \`${property}\`` : `\`${property}\` null or missing`;
      note = VALUE_TYPE_NOTE;
      const attempt = findFirstStop(omitting);
      if (attempt?.stop.site !== undefined) {
        stoppedAt = { ...toEvidence(attempt.usage, attempt.stop.site.line), path: attempt.stop.site.path };
      }
    }
  }
  const refs = formatRefs(risky.map((call) => call.usage));
  return {
    ...finding,
    class: "rollback-risk",
    message: `${finding.message}; after a rollback the base server gets ${what} from ${refs}, which deploys with the server (client-usage)${note}`,
    evidence: capEvidence(finding, [
      ...(stoppedAt === undefined ? [] : [stoppedAt]),
      ...risky.flatMap((call) => call.operations.map((item) => toEvidence(call.usage, item.line))),
    ]),
    reclassified: {
      from: finding.class,
      by: CLIENT_USAGE_LAYER,
      reason: `${refs} deploys with the server and calls it; the base server does not accept this after a rollback`,
    },
  };
}

/**
 * The rollback view of the `openapi` findings: a forward-safe request widening that the revision
 * build of a client deployed with the server exercises becomes `rollback-risk`, since after a
 * rollback every tab opened since the deploy sends it to the base server. `usages` are those
 * revision builds.
 */
export function refineRollbackFindings(
  findings: readonly Finding[],
  usages: readonly ClientRefUsage[],
): FindingRevision[] {
  const revisions: FindingRevision[] = [];
  findings.forEach((finding, index) => {
    if (!isRollbackCandidate(finding)) return;
    const apiUsages = usages.filter((usage) => usage.api === finding.scope);
    if (apiUsages.length === 0) return;
    const refined = refineRollbackFinding(finding, apiUsages);
    if (refined !== undefined) revisions.push({ layer: OPENAPI_LAYER, index, finding: refined });
  });
  return revisions;
}
