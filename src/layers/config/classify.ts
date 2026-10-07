import type { RefTree } from "../../git/ref-tree.js";
import { type Evidence, type Finding, type FindingClass, getClassRank } from "../../model/finding.js";

export const CONFIG_LAYER = "config";

export const CONFIG_FINDING_IDS = [
  "config-key-added-required",
  "config-key-default-removed",
  "config-key-added-optional",
  "config-key-default-changed",
  "config-key-removed",
] as const;

export type ConfigFindingId = (typeof CONFIG_FINDING_IDS)[number];

/** One place that reads a configuration key. `default: null` means the place gives no default. */
export type KeyDeclaration = { key: string; line: number; default: string | null };

export type SourcedDeclaration = KeyDeclaration & { source: string; path: string };

/** Every declaration of every key at one ref, by key. */
export type KeyIndex = Map<string, SourcedDeclaration[]>;

export type ConfigAcceptEntry = { key: string; id: ConfigFindingId; reason: string };

export type AcceptUsage = { entry: ConfigAcceptEntry; count: number };

export type ClassifyKeysOptions = {
  base: KeyIndex;
  revision: KeyIndex;
  baseTree: RefTree;
  revisionTree: RefTree;
  /** Files (`getFileId(source, path)`) a source matched at both refs; their keys are compared file by file. */
  pairedFiles: ReadonlySet<string>;
};

const MAX_EVIDENCE_PER_SIDE = 5;

const FINDING_CLASS: Record<ConfigFindingId, FindingClass> = {
  "config-key-added-required": "needs-action",
  "config-key-default-removed": "needs-action",
  "config-key-added-optional": "safe",
  "config-key-default-changed": "safe",
  "config-key-removed": "safe",
};

const MESSAGES: Record<ConfigFindingId, string> = {
  "config-key-added-required":
    "new key without a default; the value must exist in production before the deploy",
  "config-key-default-removed":
    "the key had a default at the base and has none in the revision; the value must exist in production before the deploy",
  "config-key-added-optional": "new key with a default; the release runs without a value in production",
  "config-key-default-changed":
    "the default value changed; production picks up the new default unless the key is set there",
  "config-key-removed":
    "the revision no longer reads the key; keep the value in production while a rollback to the base is possible",
};

/** What one source says about one key: the finding id and the declarations that prove it. */
type SourceVerdict = { id: ConfigFindingId; base: SourcedDeclaration[]; revision: SourcedDeclaration[] };

export function addDeclarations(
  index: KeyIndex,
  declarations: KeyDeclaration[],
  origin: { source: string; path: string },
): void {
  for (const declaration of declarations) {
    const entries = index.get(declaration.key) ?? [];
    entries.push({ ...declaration, ...origin });
    index.set(declaration.key, entries);
  }
}

function withoutDefault(declarations: SourcedDeclaration[]): SourcedDeclaration[] {
  return declarations.filter((declaration) => declaration.default === null);
}

/** The sorted set of distinct defaults, as one comparable string. */
function getDefaults(declarations: SourcedDeclaration[]): string {
  const defaults = new Set<string>();
  for (const declaration of declarations) {
    if (declaration.default !== null) defaults.add(declaration.default);
  }
  return JSON.stringify([...defaults].sort());
}

/**
 * Classifies the declarations of one key in one comparison unit (see `groupByUnit`). A key is required at a ref when one of
 * its declarations there has no default.
 */
function classifyInUnit(before: SourcedDeclaration[], after: SourcedDeclaration[]): SourceVerdict | null {
  if (before.length === 0 && after.length === 0) return null;
  if (before.length === 0) {
    const required = withoutDefault(after);
    return required.length > 0
      ? { id: "config-key-added-required", base: [], revision: required }
      : { id: "config-key-added-optional", base: [], revision: after };
  }
  if (after.length === 0) return { id: "config-key-removed", base: before, revision: [] };
  if (withoutDefault(before).length > 0) return null;
  const required = withoutDefault(after);
  if (required.length > 0) return { id: "config-key-default-removed", base: before, revision: required };
  if (getDefaults(before) !== getDefaults(after)) {
    return { id: "config-key-default-changed", base: before, revision: after };
  }
  return null;
}

function compareText(a: string, b: string): number {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

function toEvidence(tree: RefTree, declarations: SourcedDeclaration[]): Evidence[] {
  const unique = new Map<string, SourcedDeclaration>();
  for (const declaration of declarations) {
    unique.set(`${declaration.path}:${declaration.line}`, declaration);
  }
  return [...unique.values()]
    .sort((a, b) => compareText(a.path, b.path) || a.line - b.line)
    .slice(0, MAX_EVIDENCE_PER_SIDE)
    .map((declaration) => ({
      side: tree.side,
      ref: tree.ref,
      commit: tree.commit,
      path: declaration.path,
      line: declaration.line,
    }));
}

export function getFileId(source: string, path: string): string {
  return `${source}\0${path}`;
}

/**
 * Groups declarations into comparison units: one per file a source matched at both refs, so one
 * file cannot mask a change in another (a test compose file must not hide a new production
 * secret), plus one per source for the files present at one ref only, so a moved file does not
 * invent added or removed keys.
 */
function groupByUnit(
  declarations: SourcedDeclaration[] | undefined,
  pairedFiles: ReadonlySet<string>,
): Map<string, SourcedDeclaration[]> {
  const groups = new Map<string, SourcedDeclaration[]>();
  for (const declaration of declarations ?? []) {
    const fileId = getFileId(declaration.source, declaration.path);
    const unit = pairedFiles.has(fileId) ? fileId : getFileId(declaration.source, "");
    groups.set(unit, [...(groups.get(unit) ?? []), declaration]);
  }
  return groups;
}

/**
 * Compares the keys of both refs. Each comparison unit is classified on its own, so one source
 * or file cannot mask a change in another; sources that reach the same verdict for a key share one finding, and
 * a key gets only the findings of its most severe class.
 * Messages never carry default values, which may be secrets.
 */
export function classifyKeys({
  base,
  revision,
  baseTree,
  revisionTree,
  pairedFiles,
}: ClassifyKeysOptions): Finding[] {
  const findings: Finding[] = [];
  const keys = [...new Set([...base.keys(), ...revision.keys()])].sort(compareText);
  for (const key of keys) {
    const before = groupByUnit(base.get(key), pairedFiles);
    const after = groupByUnit(revision.get(key), pairedFiles);
    const verdicts = new Map<
      ConfigFindingId,
      { sources: Set<string>; base: SourcedDeclaration[]; revision: SourcedDeclaration[] }
    >();
    for (const unit of new Set([...before.keys(), ...after.keys()])) {
      const verdict = classifyInUnit(before.get(unit) ?? [], after.get(unit) ?? []);
      if (verdict === null) continue;
      const merged = verdicts.get(verdict.id) ?? { sources: new Set<string>(), base: [], revision: [] };
      for (const declaration of [...verdict.base, ...verdict.revision])
        merged.sources.add(declaration.source);
      merged.base.push(...verdict.base);
      merged.revision.push(...verdict.revision);
      verdicts.set(verdict.id, merged);
    }
    // Only the most severe verdicts are reported: a source that documents a default must not add a
    // `safe` line next to the `needs-action` of a source that requires the key.
    const topRank = Math.max(...[...verdicts.keys()].map((id) => getClassRank(FINDING_CLASS[id])));
    for (const id of CONFIG_FINDING_IDS) {
      const merged = verdicts.get(id);
      if (merged === undefined || getClassRank(FINDING_CLASS[id]) !== topRank) continue;
      findings.push({
        layer: CONFIG_LAYER,
        scope: [...merged.sources].sort(compareText).join(", "),
        id,
        subject: key,
        class: FINDING_CLASS[id],
        message: MESSAGES[id],
        evidence: [...toEvidence(baseTree, merged.base), ...toEvidence(revisionTree, merged.revision)],
      });
    }
  }
  return findings;
}

/** Marks findings matched by an accept entry (same key and finding id). */
export function applyAccept(
  findings: Finding[],
  accept: ConfigAcceptEntry[],
): { findings: Finding[]; usage: AcceptUsage[] } {
  const usage = accept.map((entry) => ({ entry, count: 0 }));
  const result = findings.map((finding) => {
    const match = usage.find(({ entry }) => entry.key === finding.subject && entry.id === finding.id);
    if (match === undefined) return finding;
    match.count += 1;
    return { ...finding, accepted: { reason: match.entry.reason } };
  });
  return { findings: result, usage };
}
