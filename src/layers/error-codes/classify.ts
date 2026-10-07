import { matchesGlob } from "../../git/glob.js";
import type { Evidence, Finding } from "../../model/finding.js";
import {
  ERROR_CODE_FINDING_CLASSES,
  ERROR_CODES_LAYER,
  type ErrorCodeAccept,
  type ErrorCodeFindingId,
} from "./config.js";

/** Where a code is declared: the code source that captured it first and its first line. */
export type CodeDeclaration = { source: string; evidence: Evidence };

/** Codes of one side, by code. */
export type CodeSet = ReadonlyMap<string, CodeDeclaration>;

/** The codes one live client ref translates. */
export type ClientRefCodes = { ref: string; commit: string; paths: string[]; codes: ReadonlySet<string> };

export type ClientCodes = {
  client: string;
  refs: ClientRefCodes[];
  /** The client build at the revision, for a client deployed with the server (`deployedWith: "revision"`). */
  deployed?: ClientRefCodes;
};

export type ClassifyErrorCodesOptions = { base: CodeSet; revision: CodeSet; clients: ClientCodes[] };

/** `mobile@2.0.1, 2.1.1`: a client and its refs, as reasons name them. */
export function formatClientRefs(client: string, refs: readonly { ref: string }[]): string {
  return `${client}@${refs.map(({ ref }) => ref).join(", ")}`;
}

function createFinding(
  id: ErrorCodeFindingId,
  fields: { scope: string; subject: string; message: string; evidence: Evidence[] },
): Finding {
  return { layer: ERROR_CODES_LAYER, id, class: ERROR_CODE_FINDING_CLASSES[id], ...fields };
}

/**
 * Added and removed codes, and one `error-code-unknown-to-client` per client and code that is new in
 * the revision and missing from at least one of that client's live refs.
 */
export function classifyErrorCodes({ base, revision, clients }: ClassifyErrorCodesOptions): Finding[] {
  const added = [...revision.keys()].filter((code) => !base.has(code)).sort();
  const removed = [...base.keys()].filter((code) => !revision.has(code)).sort();
  const findings: Finding[] = [];
  for (const code of added) {
    const declaration = revision.get(code) as CodeDeclaration;
    findings.push(
      createFinding("error-code-added", {
        scope: declaration.source,
        subject: code,
        message: `error code ${code} is new in the revision`,
        evidence: [declaration.evidence],
      }),
    );
  }
  for (const code of removed) {
    const declaration = base.get(code) as CodeDeclaration;
    findings.push(
      createFinding("error-code-removed", {
        scope: declaration.source,
        subject: code,
        message: `error code ${code} is no longer declared in the revision; clients only keep an unused translation`,
        evidence: [declaration.evidence],
      }),
    );
  }
  for (const { client, refs, deployed } of clients) {
    for (const code of added) {
      const lacking = refs.filter((ref) => !ref.codes.has(code));
      if (lacking.length === 0) continue;
      const declaration = revision.get(code) as CodeDeclaration;
      const finding = createFinding("error-code-unknown-to-client", {
        scope: client,
        subject: code,
        message: `error code ${code} is new in the revision and not translated by ${formatClientRefs(client, lacking)}; these builds show a generic error instead of its message`,
        evidence: [
          declaration.evidence,
          ...lacking.flatMap(({ ref, commit, paths }) =>
            paths.map((path): Evidence => ({ side: "client", ref, commit, path })),
          ),
        ],
      });
      if (deployed?.codes.has(code)) {
        // The build deployed with the server translates it; only tabs opened before the deploy lack it.
        finding.class = "safe";
        finding.reclassified = {
          from: ERROR_CODE_FINDING_CLASSES["error-code-unknown-to-client"],
          by: ERROR_CODES_LAYER,
          reason: `only ${formatClientRefs(client, lacking)} tabs opened before the deploy; ${client}@${deployed.ref} translates it`,
        };
      }
      findings.push(finding);
    }
  }
  return findings;
}

/**
 * Marks the `error-code-unknown-to-client` findings an entry accepts (its code may be a glob) and notes
 * each entry's use. A `safe` finding is left alone, so an entry that `returnedBy` made redundant reads as unused.
 */
export function applyErrorCodeAccept(
  findings: Finding[],
  accept: readonly ErrorCodeAccept[],
): { findings: Finding[]; notes: string[] } {
  const counts = accept.map(() => 0);
  const result = findings.map((finding) => {
    if (finding.id !== "error-code-unknown-to-client" || finding.class === "safe") return finding;
    const position = accept.findIndex(
      (entry) =>
        matchesGlob(finding.subject, entry.code) &&
        (entry.client === undefined || entry.client === finding.scope),
    );
    if (position === -1) return finding;
    counts[position] = (counts[position] ?? 0) + 1;
    return { ...finding, accepted: { reason: (accept[position] as ErrorCodeAccept).reason } };
  });
  const notes = accept.map((entry, position) => {
    const target = `${entry.code}${entry.client === undefined ? "" : ` for ${entry.client}`}`;
    const count = counts[position] ?? 0;
    return count === 0
      ? `accept entry ${target} matched nothing; remove it if the code is translated now`
      : `accept entry ${target} accepted ${count} finding(s)`;
  });
  return { findings: result, notes };
}
