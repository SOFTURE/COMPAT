import type { Finding, LayerResult } from "../model/finding.js";
import { err, ok, type Result } from "../result.js";
import type { FindingRevision, LayerOutput } from "./layer.js";

const FIXED_KEYS = ["layer", "scope", "id", "subject"] as const;

function describeRevision(revision: FindingRevision): string {
  return `revision of ${revision.layer} finding #${revision.index}`;
}

function checkRevision(original: Finding, revised: Finding): string | undefined {
  for (const key of FIXED_KEYS) {
    if (original[key] !== revised[key]) return `changes ${key}`;
  }
  if (JSON.stringify(original.accepted) !== JSON.stringify(revised.accepted)) return "changes accepted";
  if (JSON.stringify(original.exposure) !== JSON.stringify(revised.exposure)) return "changes exposure";
  return undefined;
}

/**
 * Applies the revisions a refining layer returned to the results of the layers before it.
 * A revision may change a finding's class, message, evidence and `reclassified`, never which
 * finding it is, so a refinement can never hide one. Any invalid revision rejects them all.
 */
export function applyRevisions(
  results: readonly LayerResult[],
  revisions: readonly FindingRevision[],
): Result<LayerResult[]> {
  const revised = results.map((result) =>
    result.status === "skipped" ? result : { ...result, findings: [...result.findings] },
  );
  const seen = new Set<string>();
  for (const revision of revisions) {
    const target = revised.find((result) => result.layer === revision.layer);
    if (target === undefined || target.status === "skipped") {
      return err(`${describeRevision(revision)}: no earlier layer with findings has that name`);
    }
    const original = target.findings[revision.index];
    if (!Number.isInteger(revision.index) || original === undefined) {
      return err(`${describeRevision(revision)}: no such finding`);
    }
    const key = `${revision.layer}#${revision.index}`;
    if (seen.has(key)) return err(`${describeRevision(revision)}: revised twice`);
    seen.add(key);
    const problem = checkRevision(original, revision.finding);
    if (problem !== undefined) return err(`${describeRevision(revision)} ${problem}`);
    target.findings[revision.index] = revision.finding;
  }
  return ok(revised);
}

/** Splits what `run` returned into the layer's own result and its revisions. */
export function splitOutput(output: LayerOutput): { result: LayerResult; revisions: FindingRevision[] } {
  const { revisions, ...result } = output;
  return { result: result as LayerResult, revisions: revisions ?? [] };
}
