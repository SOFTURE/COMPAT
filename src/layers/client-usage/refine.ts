import type { Evidence, Finding } from "../../model/finding.js";
import type { FindingRevision } from "../layer.js";
import { OPENAPI_LAYER } from "../openapi/classify.js";
import { CLIENT_USAGE_LAYER } from "./config.js";
import { findSentLiterals, type SentSite, type SourceFile } from "./find-sent-literals.js";
import { isSamePath, parseOperation } from "./paths.js";
import type { ClientModel, ClientOperation, TypeMember } from "./read-typescript-client.js";

/** oasdiff checks a client that always sends the property makes harmless, by what "always sends" must mean. */
export const PROPERTY_RULES: Record<string, "required" | "not-nullable"> = {
  "request-property-became-required": "required",
  "new-required-request-property": "required",
  "request-property-became-not-nullable": "not-nullable",
};

const MAX_EVIDENCE = 10;

/** What one client ref calls, read from its generated client. */
export type ClientRefUsage = {
  client: string;
  api: string;
  ref: string;
  commit: string;
  /** Repository-relative path of the generated client at this ref. */
  clientPath: string;
  model: ClientModel;
  /** Identifiers in the client's own sources; `undefined` when no sources are configured. */
  sourceIdentifiers?: Set<string>;
  /** The client's own sources; `undefined` when none are configured. */
  sources?: SourceFile[];
  /** Branch sites in the client's own sources per enum branch target key; `undefined` without sources. */
  branches?: Map<string, { path: string; line: number }[]>;
  /** Set for a client deployed with the server: this ref only runs in tabs opened before the deploy. */
  deployedWith?: "revision";
};

export type RefineSummary = { revisions: FindingRevision[]; toSafe: number; withEvidence: number };

type Call = { usage: ClientRefUsage; operations: ClientOperation[] };

/** Whether the ref's own code calls the operation; without sources every client operation counts. */
export function isCalled(usage: ClientRefUsage, operation: ClientOperation): boolean {
  if (usage.sourceIdentifiers === undefined || operation.functionName === undefined) return true;
  return usage.sourceIdentifiers.has(operation.functionName);
}

function findCalls(usage: ClientRefUsage, method: string, path: string): ClientOperation[] {
  return usage.model.operations.filter(
    (operation) =>
      (operation.method === "*" || operation.method === method) &&
      isSamePath(operation.path, path) &&
      isCalled(usage, operation),
  );
}

/** `mobile@2.0.1, 2.1.1; admin@1.0.0`: refs grouped by client in the order given. */
export function formatRefs(usages: readonly { client: string; ref: string }[]): string {
  const byClient = new Map<string, string[]>();
  for (const usage of usages) byClient.set(usage.client, [...(byClient.get(usage.client) ?? []), usage.ref]);
  return [...byClient].map(([client, refs]) => `${client}@${refs.join(", ")}`).join("; ");
}

export function toEvidence(usage: ClientRefUsage, line?: number): Evidence {
  const evidence: Evidence = { side: "client", ref: usage.ref, commit: usage.commit, path: usage.clientPath };
  if (line !== undefined) evidence.line = line;
  return evidence;
}

/** The first back-quoted name in an oasdiff message: `the request property \`a/b\` became required` → ["a", "b"]. */
export function readPropertyPath(message: string): string[] | undefined {
  const match = /`([^`]+)`/.exec(message);
  if (!match) return undefined;
  const segments = (match[1] as string).split("/").filter((segment) => segment !== "");
  return segments.length > 0 ? segments : undefined;
}

/**
 * The property path as members of the client types: `allOf[...]` segments are dropped, since a
 * generated client flattens allOf into one type or an intersection. `undefined` under `oneOf[...]`
 * or `anyOf[...]`, where no single client type proves the property is always sent.
 */
function toMemberPath(propertyPath: string[]): string[] | undefined {
  if (propertyPath.some((segment) => /^(oneOf|anyOf)\[/.test(segment))) return undefined;
  return propertyPath.filter((segment) => !segment.startsWith("allOf["));
}

/** Where the client proves it always sends the property: the type declaration, or the call sites' literals. */
type SentProof = { by: "type"; member: TypeMember } | { by: "call-sites"; sites: SentSite[] };

/**
 * How the call always sends the property under `rule`, else `undefined`. The generated type mirrors the
 * base contract, which allowed the omission, so when it does not prove it the call sites' literals may.
 */
function findAlwaysSent(
  usage: ClientRefUsage,
  operation: ClientOperation,
  propertyPath: string[],
  rule: "required" | "not-nullable",
): SentProof | undefined {
  const memberPath = toMemberPath(propertyPath);
  if (memberPath === undefined || operation.body === undefined) return undefined;
  const member = findDeclaredAlwaysSent(usage.model, operation, memberPath, rule);
  if (member !== undefined) return { by: "type", member };
  if (usage.sources === undefined || operation.functionName === undefined) return undefined;
  const sites = findSentLiterals({
    sources: usage.sources,
    functionName: operation.functionName,
    bodyIndex: operation.body.index,
    memberPath,
    clientTypes: usage.model.types,
  });
  return sites === undefined ? undefined : { by: "call-sites", sites };
}

/** The declaration of the property if the body type always sends it under `rule`, else `undefined`. */
function findDeclaredAlwaysSent(
  model: ClientModel,
  operation: ClientOperation,
  memberPath: string[],
  rule: "required" | "not-nullable",
): TypeMember | undefined {
  if (operation.body === undefined || operation.body.isOptional) return undefined;
  let typeName: string | undefined = operation.body.typeName;
  let member: TypeMember | undefined;
  for (const segment of memberPath) {
    if (typeName === undefined) return undefined;
    member = model.types.get(typeName)?.get(segment);
    if (member === undefined) return undefined;
    typeName = member.typeName;
  }
  if (member === undefined) return undefined;
  // An omitted property can reach the server as null, so the not-nullable rule needs it always sent too.
  if (member.isOptional) return undefined;
  if (rule === "not-nullable" && member.isNullable) return undefined;
  return member;
}

function toProofEvidence(usage: ClientRefUsage, proof: SentProof): Evidence[] {
  if (proof.by === "type") return [toEvidence(usage, proof.member.line)];
  return proof.sites.map((site) => ({ ...toEvidence(usage, site.line), path: site.path }));
}

function capEvidence(finding: Finding, added: Evidence[]): Evidence[] {
  return [...finding.evidence, ...added.slice(0, MAX_EVIDENCE)];
}

/** `; stale bundle only` when every calling ref belongs to a client deployed with the server. */
function describeStaleBundle(calls: readonly Call[]): string {
  return calls.every((call) => call.usage.deployedWith === "revision")
    ? "; stale bundle only: the client deploys with the server, so only tabs opened before the deploy run these builds"
    : "";
}

function refineFinding(finding: Finding, usages: readonly ClientRefUsage[]): Finding | undefined {
  const operation = parseOperation(finding.subject);
  if (operation === undefined) return undefined;
  const calls: Call[] = usages
    .map((usage) => ({ usage, operations: findCalls(usage, operation.method, operation.path) }))
    .filter((call) => call.operations.length > 0);

  if (calls.length === 0) {
    return {
      ...finding,
      class: "safe",
      evidence: capEvidence(
        finding,
        usages.map((usage) => toEvidence(usage)),
      ),
      reclassified: {
        from: finding.class,
        by: CLIENT_USAGE_LAYER,
        reason: `not called by ${formatRefs(usages)}`,
      },
    };
  }

  const rule = PROPERTY_RULES[finding.id];
  const propertyPath = rule === undefined ? undefined : readPropertyPath(finding.message);
  if (rule !== undefined && propertyPath !== undefined) {
    const sent = calls.map((call) => ({
      call,
      proofs: call.operations.map((item) => findAlwaysSent(call.usage, item, propertyPath, rule)),
    }));
    const omitting = sent.filter(({ proofs }) => proofs.some((proof) => proof === undefined));
    const property = propertyPath.join("/");
    if (omitting.length === 0) {
      const what = rule === "required" ? "always sent" : "always sent non-null";
      const proofs = sent.flatMap(({ call, proofs }) =>
        proofs.map((proof) => ({ usage: call.usage, proof })),
      );
      const where = proofs.some(({ proof }) => proof?.by === "call-sites") ? "the call sites of " : "";
      return {
        ...finding,
        class: "safe",
        evidence: capEvidence(
          finding,
          proofs.flatMap(({ usage, proof }) => toProofEvidence(usage, proof as SentProof)),
        ),
        reclassified: {
          from: finding.class,
          by: CLIENT_USAGE_LAYER,
          reason: `\`${property}\` is ${what} by ${where}${formatRefs(calls.map((call) => call.usage))}`,
        },
      };
    }
    const omitters = formatRefs(omitting.map(({ call }) => call.usage));
    return {
      ...finding,
      message: `${finding.message}; ${omitters} may send it without \`${property}\`${rule === "not-nullable" ? " or with null" : ""} (client-usage)${describeStaleBundle(omitting.map(({ call }) => call))}`,
      evidence: capEvidence(
        finding,
        omitting.flatMap(({ call }) => call.operations.map((item) => toEvidence(call.usage, item.line))),
      ),
    };
  }

  return {
    ...finding,
    message: `${finding.message}; called by ${formatRefs(calls.map((call) => call.usage))} (client-usage)${describeStaleBundle(calls)}`,
    evidence: capEvidence(
      finding,
      calls.flatMap((call) => call.operations.map((item) => toEvidence(call.usage, item.line))),
    ),
  };
}

/**
 * Re-classifies the `openapi` findings of every API that has live clients: an operation no client
 * ref calls drops to `safe`; a request property every calling ref always sends drops to `safe`
 * for the property rules; anything still used keeps its class and gains the calls as evidence.
 * Accepted and `safe` findings are left alone.
 */
export function refineFindings(
  findings: readonly Finding[],
  usages: readonly ClientRefUsage[],
): RefineSummary {
  const summary: RefineSummary = { revisions: [], toSafe: 0, withEvidence: 0 };
  findings.forEach((finding, index) => {
    if (finding.layer !== OPENAPI_LAYER || finding.accepted || finding.class === "safe") return;
    const apiUsages = usages.filter((usage) => usage.api === finding.scope);
    if (apiUsages.length === 0) return;
    const refined = refineFinding(finding, apiUsages);
    if (refined === undefined) return;
    summary.revisions.push({ layer: OPENAPI_LAYER, index, finding: refined });
    if (refined.class === "safe") summary.toSafe++;
    else summary.withEvidence++;
  });
  return summary;
}
