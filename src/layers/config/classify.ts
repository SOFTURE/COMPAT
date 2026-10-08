import type { RefTree } from "../../git/ref-tree.js";
import { type Evidence, type Finding, type FindingClass, getClassRank } from "../../model/finding.js";
import type { KeyIdentity } from "./keys.js";

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

/** Where a compose service sets a key, so the default the app file lacks comes from the deploy. */
export type ServiceOverride = { service: string; path: string; line: number };

export type SourcedDeclaration = KeyDeclaration & {
  source: string;
  path: string;
  /** The file the declaration is compared under when it differs from `path`, e.g. the base of a layered file. */
  unit?: string;
  /** The compose service that runs the app this declaration belongs to. */
  service?: string;
  override?: ServiceOverride;
};

/** Every declaration of every key at one ref, by key identity. */
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

/**
 * What one source says about one key: the finding id and the declarations that prove it.
 * `overridden` marks a key that needs a value which the compose service of every declaration sets.
 */
type SourceVerdict = {
  id: ConfigFindingId;
  base: SourcedDeclaration[];
  revision: SourcedDeclaration[];
  overridden: boolean;
};

/**
 * Adds declarations to an index under the identity of their key (see `getKeyIdentity`); each
 * declaration keeps the spelling it was written with.
 */
export function addDeclarations(
  index: KeyIndex,
  declarations: KeyDeclaration[],
  origin: { source: string; path: string },
  identify: KeyIdentity = (key) => key,
): void {
  for (const declaration of declarations) {
    const id = identify(declaration.key);
    const entries = index.get(id) ?? [];
    entries.push({ ...declaration, ...origin });
    index.set(id, entries);
  }
}

/** The message of a finding, plus the spellings of the key when any differs from the subject. */
function getMessage(id: ConfigFindingId, subject: string, declarations: SourcedDeclaration[]): string {
  const spellings = [...new Set(declarations.map((declaration) => declaration.key))].sort(compareText);
  if (spellings.every((spelling) => spelling === subject)) return MESSAGES[id];
  return `${MESSAGES[id]} (spelled ${spellings.join(", ")})`;
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
      ? { id: "config-key-added-required", base: [], revision: required, overridden: isOverridden(required) }
      : { id: "config-key-added-optional", base: [], revision: after, overridden: false };
  }
  if (after.length === 0) return { id: "config-key-removed", base: before, revision: [], overridden: false };
  if (withoutDefault(before).length > 0) return null;
  const required = withoutDefault(after);
  if (required.length > 0) {
    return {
      id: "config-key-default-removed",
      base: before,
      revision: required,
      overridden: isOverridden(required),
    };
  }
  if (getDefaults(before) !== getDefaults(after)) {
    return { id: "config-key-default-changed", base: before, revision: after, overridden: false };
  }
  return null;
}

function isOverridden(declarations: SourcedDeclaration[]): boolean {
  return declarations.every((declaration) => declaration.override !== undefined);
}

/** Names the compose services that set the key, or those that should but do not. */
function describeServices(declarations: SourcedDeclaration[], overridden: boolean): string {
  if (overridden) {
    const services = [...new Set(declarations.map((declaration) => declaration.override?.service ?? ""))];
    return `; compose ${formatServices(services)} set${services.length === 1 ? "s" : ""} it`;
  }
  const missing = declarations.filter(
    (declaration) => declaration.service !== undefined && declaration.override === undefined,
  );
  if (missing.length === 0) return "";
  const services = [...new Set(missing.map((declaration) => declaration.service ?? ""))];
  return `; compose ${formatServices(services)} do${services.length === 1 ? "es" : ""} not set it`;
}

function formatServices(services: string[]): string {
  const names = services.sort(compareText).map((service) => `"${service}"`);
  return `${names.length === 1 ? "service" : "services"} ${names.join(", ")}`;
}

function compareText(a: string, b: string): number {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

export function toEvidence(tree: RefTree, declarations: SourcedDeclaration[]): Evidence[] {
  const unique = new Map<string, SourcedDeclaration>();
  for (const declaration of declarations) {
    unique.set(`${declaration.path}:${declaration.line}`, declaration);
  }
  return toSortedEvidence(tree, [...unique.values()]);
}

function toSortedEvidence(tree: RefTree, places: { path: string; line: number }[]): Evidence[] {
  return places
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
    const fileId = getFileId(declaration.source, declaration.unit ?? declaration.path);
    const unit = pairedFiles.has(fileId) ? fileId : getFileId(declaration.source, "");
    groups.set(unit, [...(groups.get(unit) ?? []), declaration]);
  }
  return groups;
}

type MergedVerdict = {
  id: ConfigFindingId;
  overridden: boolean;
  sources: Set<string>;
  base: SourcedDeclaration[];
  revision: SourcedDeclaration[];
};

/** A key a compose service sets needs no other value in production, so its finding is `safe`. */
function getVerdictClass(verdict: MergedVerdict): FindingClass {
  return verdict.overridden ? "safe" : FINDING_CLASS[verdict.id];
}

/**
 * Compares the keys of both refs; the subject of a finding is the key identity. Each comparison unit is classified on its own, so one source
 * or file cannot mask a change in another; sources that reach the same verdict for a key share one finding, and
 * a key gets only the findings of its most severe class.
 * Messages never carry default values, which may be secrets; only `watch` prints those of watched keys.
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
    const verdicts = new Map<string, MergedVerdict>();
    for (const unit of new Set([...before.keys(), ...after.keys()])) {
      const verdict = classifyInUnit(before.get(unit) ?? [], after.get(unit) ?? []);
      if (verdict === null) continue;
      const group = `${verdict.id}${verdict.overridden ? ":overridden" : ""}`;
      const merged = verdicts.get(group) ?? {
        id: verdict.id,
        overridden: verdict.overridden,
        sources: new Set<string>(),
        base: [],
        revision: [],
      };
      for (const declaration of [...verdict.base, ...verdict.revision])
        merged.sources.add(declaration.source);
      merged.base.push(...verdict.base);
      merged.revision.push(...verdict.revision);
      verdicts.set(group, merged);
    }
    // Only the most severe verdicts are reported: a source that documents a default must not add a
    // `safe` line next to the `needs-action` of a source that requires the key.
    const ordered = [...verdicts.values()].sort(
      (a, b) =>
        CONFIG_FINDING_IDS.indexOf(a.id) - CONFIG_FINDING_IDS.indexOf(b.id) ||
        Number(a.overridden) - Number(b.overridden),
    );
    const topRank = Math.max(...ordered.map((verdict) => getClassRank(getVerdictClass(verdict))));
    for (const merged of ordered) {
      const findingClass = getVerdictClass(merged);
      if (getClassRank(findingClass) !== topRank) continue;
      const overrides = merged.revision.flatMap((declaration) => declaration.override ?? []);
      findings.push({
        layer: CONFIG_LAYER,
        scope: [...merged.sources].sort(compareText).join(", "),
        id: merged.id,
        subject: key,
        class: findingClass,
        message:
          getMessage(merged.id, key, [...(base.get(key) ?? []), ...(revision.get(key) ?? [])]) +
          describeServices(merged.revision, merged.overridden),
        evidence: [
          ...toEvidence(baseTree, merged.base),
          ...toEvidence(revisionTree, merged.revision),
          ...toSortedEvidence(revisionTree, overrides),
        ],
      });
    }
  }
  return findings;
}

/** Marks findings matched by an accept entry (the same key identity and finding id). */
export function applyAccept(
  findings: Finding[],
  accept: ConfigAcceptEntry[],
  identify: KeyIdentity = (key) => key,
): { findings: Finding[]; usage: AcceptUsage[] } {
  const usage = accept.map((entry) => ({ entry, count: 0 }));
  const result = findings.map((finding) => {
    const match = usage.find(
      ({ entry }) => identify(entry.key) === finding.subject && entry.id === finding.id,
    );
    if (match === undefined) return finding;
    match.count += 1;
    return { ...finding, accepted: { reason: match.entry.reason } };
  });
  return { findings: result, usage };
}
