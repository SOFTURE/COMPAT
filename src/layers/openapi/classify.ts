import { isAbsolute, relative, sep } from "node:path";
import type { RefTree } from "../../git/ref-tree.js";
import type { Evidence, Finding, FindingClass } from "../../model/finding.js";
import type { AcceptEntry } from "./config.js";
import type { OasdiffChange } from "./oasdiff.js";
import type { ResolvedSpec } from "./spec-source.js";

export const OPENAPI_LAYER = "openapi";

const LEVEL_TO_CLASS: Record<number, FindingClass> = { 3: "breaking", 2: "needs-action", 1: "safe" };

type FoundSpec = Extract<ResolvedSpec, { status: "found" }>;

export type ClassifyOptions = {
  apiName: string;
  changes: OasdiffChange[];
  base: RefTree;
  revision: RefTree;
  baseSpec: FoundSpec;
  revisionSpec: FoundSpec;
};

export function getOperation(change: OasdiffChange): string | undefined {
  return change.operation && change.path ? `${change.operation} ${change.path}` : undefined;
}

function toEvidencePath(file: string, spec: FoundSpec): string {
  if (spec.root === null) return spec.displayPath;
  const fromRoot = relative(spec.root, file);
  if (fromRoot === "" || fromRoot.startsWith("..") || isAbsolute(fromRoot)) return spec.displayPath;
  return fromRoot.split(sep).join("/");
}

function buildEvidence(
  source: OasdiffChange["baseSource"],
  tree: RefTree,
  spec: FoundSpec,
): Evidence | undefined {
  if (!source) return undefined;
  const evidence: Evidence = {
    side: tree.side,
    ref: tree.ref,
    commit: tree.commit,
    path: toEvidencePath(source.file, spec),
  };
  if (source.line !== undefined && source.line > 0) evidence.line = source.line;
  return evidence;
}

export type ClassifiedChange = { finding: Finding; operation: string | undefined };

export function classifyChanges(options: ClassifyOptions): ClassifiedChange[] {
  return options.changes.map((change) => {
    const evidence = [
      buildEvidence(change.baseSource, options.base, options.baseSpec),
      buildEvidence(change.revisionSource, options.revision, options.revisionSpec),
    ].filter((item): item is Evidence => item !== undefined);
    if (evidence.length === 0) {
      evidence.push({
        side: "revision",
        ref: options.revision.ref,
        commit: options.revision.commit,
        path: options.revisionSpec.displayPath,
      });
    }
    const operation = getOperation(change);
    const finding: Finding = {
      layer: OPENAPI_LAYER,
      scope: options.apiName,
      id: change.id,
      subject: operation ?? change.section ?? "(spec)",
      class: LEVEL_TO_CLASS[change.level] ?? "breaking",
      message: change.text,
      evidence,
    };
    return { finding, operation };
  });
}

export type AcceptUsage = { entry: AcceptEntry; count: number };

/**
 * Marks findings covered by an accept entry. An entry with an operation matches only that
 * operation; an entry without one matches only changes that belong to no operation, so a
 * reviewed false positive on one endpoint never hides the same check on another.
 */
export function applyAccept(
  changes: ClassifiedChange[],
  accept: AcceptEntry[],
): { findings: Finding[]; usage: AcceptUsage[] } {
  const usage = accept.map((entry) => ({ entry, count: 0 }));
  const result = changes.map(({ finding, operation }) => {
    const match = usage.find(({ entry }) => entry.id === finding.id && entry.operation === operation);
    if (!match) return finding;
    match.count += 1;
    return { ...finding, accepted: { reason: match.entry.reason } };
  });
  return { findings: result, usage };
}
