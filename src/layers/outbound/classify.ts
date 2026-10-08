import { matchesGlob } from "../../git/glob.js";
import type { Evidence, Finding } from "../../model/finding.js";
import { normalizeKey } from "../config/keys.js";
import {
  OUTBOUND_FINDING_CLASSES,
  OUTBOUND_LAYER,
  type OutboundAccept,
  type OutboundFindingId,
} from "./config.js";
import type { DeployOverride } from "./deploy-overrides.js";

const CHECK_PRODUCTION = "API enabled for the credential, key restrictions, quotas, egress rules";

/**
 * Where a target is called: the target source that captured it first and its first line. A target read from a
 * configuration key the deploy sets is a `deployed-key`: production calls whatever the deploy puts in that key, so
 * the target is the key (`Shop:BaseUrl`) and the captured host is only the file default.
 */
export type TargetDeclaration =
  | { kind: "host"; source: string; evidence: Evidence }
  | {
      kind: "deployed-key";
      source: string;
      evidence: Evidence;
      /** The key as the target source captured it. */
      key: string;
      /** The normalized target the file declares, which production does not call. */
      fileTarget: string;
      deploy: DeployOverride;
    };

/** Targets of one side, by target identity: the normalized target, or the deploy key id of a deployed key. */
export type TargetSet = ReadonlyMap<string, TargetDeclaration>;

/** The subject of a finding: the target, or the key a deployed-key target is read from. */
function getSubject(id: string, declaration: TargetDeclaration): string {
  return declaration.kind === "deployed-key" ? declaration.key : id;
}

/** `SHOP_BASE_URL at deploy via Shop__BaseUrl of compose service api`; `set at deploy` for a literal value. */
function describeDeploy(deploy: DeployOverride): string {
  const variables =
    deploy.variables.length > 0 ? `${deploy.variables.join(", ")} at deploy` : "set at deploy";
  return `${variables} via ${deploy.key} of compose service ${deploy.service}`;
}

function describeAdded(subject: string, declaration: TargetDeclaration): string {
  if (declaration.kind === "host") {
    return `outbound call to ${subject} is new in the revision; check that production allows it (${CHECK_PRODUCTION})`;
  }
  return (
    `outbound call through config key ${subject} (${describeDeploy(declaration.deploy)}; file default ` +
    `${declaration.fileTarget}) is new in the revision; production calls the host the deploy sets, not the file ` +
    `default; check that production allows that host (${CHECK_PRODUCTION})`
  );
}

function describeRemoved(subject: string, declaration: TargetDeclaration): string {
  if (declaration.kind === "host") return `outbound call to ${subject} is no longer made in the revision`;
  return (
    `outbound call through config key ${subject} (${describeDeploy(declaration.deploy)}; file default ` +
    `${declaration.fileTarget}) is no longer made in the revision`
  );
}

/**
 * The topic a deployed-key finding shares with the `config` finding of the same setting: the one variable the
 * deploy interpolates (`SHOP_BASE_URL`), else the key, in the normalized spelling the `config` layer reports.
 */
function getTopic(declaration: TargetDeclaration): string | undefined {
  if (declaration.kind === "host") return undefined;
  const [only, ...more] = declaration.deploy.variables;
  return normalizeKey(only !== undefined && more.length === 0 ? only : declaration.key);
}

function createFinding(
  id: OutboundFindingId,
  subject: string,
  declaration: TargetDeclaration,
  message: string,
): Finding {
  const topic = getTopic(declaration);
  return {
    layer: OUTBOUND_LAYER,
    id,
    class: OUTBOUND_FINDING_CLASSES[id],
    scope: declaration.source,
    subject,
    message,
    // The file default stays as evidence next to the compose entry that replaces it in production.
    evidence:
      declaration.kind === "host"
        ? [declaration.evidence]
        : [declaration.evidence, declaration.deploy.evidence],
    ...(topic === undefined ? {} : { topic }),
  };
}

type Describe = (subject: string, declaration: TargetDeclaration) => string;

/** One `outbound-added` per target called only in the revision and one `outbound-removed` per target called only at the base. */
export function classifyOutbound(base: TargetSet, revision: TargetSet): Finding[] {
  const toFindings = (id: OutboundFindingId, from: TargetSet, other: TargetSet, describe: Describe) =>
    [...from]
      .filter(([targetId]) => !other.has(targetId))
      .map(([targetId, declaration]) => {
        const subject = getSubject(targetId, declaration);
        return createFinding(id, subject, declaration, describe(subject, declaration));
      })
      .sort((a, b) => compareText(a.subject, b.subject));
  return [
    ...toFindings("outbound-added", revision, base, describeAdded),
    ...toFindings("outbound-removed", base, revision, describeRemoved),
  ];
}

function compareText(a: string, b: string): number {
  if (a === b) return 0;
  return a < b ? -1 : 1;
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
