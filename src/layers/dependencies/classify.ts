import { globToRegExp } from "../../git/glob.js";
import type { RefTree } from "../../git/ref-tree.js";
import { compareClass, type Evidence, type Finding, type FindingClass } from "../../model/finding.js";
import type { DependencyAcceptEntry, DependencyFindingId, WatchEntry } from "./config.js";
import { type Declaration, type Ecosystem, getPackageKey } from "./declaration.js";
import { compareVersions, getBump, isBreakingUpgrade, parseVersion, type Version } from "./versions.js";

export const DEPENDENCIES_LAYER = "dependencies";

const MAX_EVIDENCE_PER_SIDE = 5;

/** Every declaration of one package at one ref, over all files. */
export type PackageDeclarations = { ecosystem: Ecosystem; name: string; declarations: Declaration[] };

export type PackageIndex = Map<string, PackageDeclarations>;

export function addDeclarations(index: PackageIndex, declarations: Declaration[]): void {
  for (const declaration of declarations) {
    const key = getPackageKey(declaration.ecosystem, declaration.name);
    const entry = index.get(key);
    if (entry === undefined) {
      index.set(key, {
        ecosystem: declaration.ecosystem,
        name: declaration.name,
        declarations: [declaration],
      });
    } else {
      entry.declarations.push(declaration);
    }
  }
}

/** Matches a package name against `watch` and `ignore` patterns, case-insensitively. */
export function createNameMatcher(pattern: string): (name: string) => boolean {
  const regex = new RegExp(globToRegExp(pattern).source, "i");
  return (name) => regex.test(name);
}

type Verdict = { id: DependencyFindingId; class: FindingClass; message: string };

const uniqueVersions = (declarations: Declaration[]) =>
  [...new Set(declarations.map((declaration) => declaration.version))].sort();

const listVersions = (declarations: Declaration[]) => uniqueVersions(declarations).join(", ");

function getExtremes(versions: Version[]): { lowest: Version; highest: Version } {
  const sorted = [...versions].sort(compareVersions);
  return { lowest: sorted[0] as Version, highest: sorted.at(-1) as Version };
}

function describeBump(from: Version, to: Version): string {
  const bump = getBump(from, to);
  if (bump === "other") return "prerelease or revision";
  if (bump !== "major" && isBreakingUpgrade(from, to)) return `${bump} below 1.0, breaking under semver`;
  return bump;
}

/**
 * Compares the versions of one package declared at both refs. Several versions at a ref (one per
 * project) compare by their lowest and highest: a version that went down anywhere is a downgrade,
 * otherwise the jump from the lowest base to the highest revision version decides the class.
 */
function compareDeclarations(before: Declaration[], after: Declaration[]): Verdict | null {
  const beforeVersions = uniqueVersions(before);
  const afterVersions = uniqueVersions(after);
  if (JSON.stringify(beforeVersions) === JSON.stringify(afterVersions)) return null;
  const transition = `${listVersions(before)} → ${listVersions(after)}`;
  const parsedBefore = beforeVersions.map(parseVersion);
  const parsedAfter = afterVersions.map(parseVersion);
  if (parsedBefore.includes(null) || parsedAfter.includes(null)) {
    const unresolved = [...after, ...before].find((declaration) => declaration.unresolved !== undefined);
    const reason = unresolved?.unresolved ?? "the declared version is not a version number at one ref";
    return {
      id: "dependency-changed",
      class: "needs-action",
      message: `${transition}: ${reason}; compare by hand`,
    };
  }
  const base = getExtremes(parsedBefore as Version[]);
  const revision = getExtremes(parsedAfter as Version[]);
  if (
    compareVersions(revision.highest, base.highest) < 0 ||
    compareVersions(revision.lowest, base.lowest) < 0
  ) {
    return { id: "dependency-downgraded", class: "needs-action", message: `${transition}: downgraded` };
  }
  if (compareVersions(revision.highest, base.lowest) <= 0) return null;
  const from = base.lowest;
  const to = revision.highest;
  return {
    id: "dependency-upgraded",
    class: isBreakingUpgrade(from, to) ? "needs-action" : "safe",
    message: `${transition}: ${describeBump(from, to)} upgrade`,
  };
}

/** Why a finding exists although the manifest range may not have changed. */
function describeResolution(declarations: Declaration[]): string {
  const resolutions = declarations.map((declaration) => declaration.resolution);
  if (resolutions.every((resolution) => resolution === undefined)) return "";
  if (resolutions.every((resolution) => resolution === "transitive"))
    return "; transitive, resolved from lockfile";
  return "; resolved from lockfile";
}

function compareText(a: string, b: string): number {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

function toEvidence(tree: RefTree, declarations: Declaration[]): Evidence[] {
  const unique = new Map(
    declarations.map((declaration) => [`${declaration.path}:${declaration.line}`, declaration]),
  );
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

export type ClassifyOptions = {
  base: PackageIndex;
  revision: PackageIndex;
  baseTree: RefTree;
  revisionTree: RefTree;
  watch: WatchEntry[];
  ignore: string[];
};

/** The distinct versions of one package at each ref; empty on the side where it is not declared. */
export type Transition = { before: string[]; after: string[] };

export type Classified = { findings: Finding[]; transitions: Map<Finding, Transition>; ignoredCount: number };

/** Findings for every package whose declared versions differ between the refs. */
export function classifyPackages(options: ClassifyOptions): Classified {
  const isIgnored = options.ignore.map(createNameMatcher);
  const watch = options.watch.map((entry) => ({ entry, matches: createNameMatcher(entry.name) }));
  const keys = [...new Set([...options.base.keys(), ...options.revision.keys()])].sort(compareText);
  const findings: Finding[] = [];
  const transitions = new Map<Finding, Transition>();
  let ignoredCount = 0;
  for (const key of keys) {
    const before = options.base.get(key);
    const after = options.revision.get(key);
    const known = (after ?? before) as PackageDeclarations;
    if (isIgnored.some((matches) => matches(known.name))) {
      ignoredCount++;
      continue;
    }
    let verdict: Verdict | null;
    if (before === undefined) {
      verdict = {
        id: "dependency-added",
        class: "safe",
        message: `new dependency at ${listVersions(known.declarations)}`,
      };
    } else if (after === undefined) {
      verdict = {
        id: "dependency-removed",
        class: "safe",
        message: `no longer declared (was ${listVersions(before.declarations)})`,
      };
    } else {
      verdict = compareDeclarations(before.declarations, after.declarations);
    }
    if (verdict === null) continue;
    let findingClass = verdict.class;
    let message =
      verdict.message + describeResolution([...(before?.declarations ?? []), ...(after?.declarations ?? [])]);
    for (const { entry, matches } of watch) {
      if (!matches(known.name)) continue;
      if (entry.class !== undefined && compareClass(entry.class, findingClass) > 0) {
        findingClass = entry.class;
        message += `; watched package (${entry.name})`;
      }
      if (entry.releaseNotes !== undefined) message += `; release notes: ${entry.releaseNotes}`;
    }
    const finding: Finding = {
      layer: DEPENDENCIES_LAYER,
      scope: known.ecosystem,
      id: verdict.id,
      subject: known.name,
      class: findingClass,
      message,
      evidence: [
        ...toEvidence(options.baseTree, before?.declarations ?? []),
        ...toEvidence(options.revisionTree, after?.declarations ?? []),
      ],
    };
    findings.push(finding);
    transitions.set(finding, {
      before: uniqueVersions(before?.declarations ?? []),
      after: uniqueVersions(after?.declarations ?? []),
    });
  }
  return { findings, transitions, ignoredCount };
}

/**
 * `count` findings accepted; `stale` lists transitions an entry with `from`/`to` matched by id and
 * name but not by versions, so the reviewed reason is not reused for versions nobody reviewed.
 * `acceptedBreaking` tells whether the entry accepted a `needs-action` upgrade.
 */
export type AcceptUsage = {
  entry: DependencyAcceptEntry;
  count: number;
  stale: string[];
  acceptedBreaking: boolean;
};

/** Whether a version an entry names is one of the declared ones; `^1.2.0` matches `1.2.0`. */
function isListedVersion(expected: string | undefined, declared: string[]): boolean {
  if (expected === undefined) return true;
  const parsed = parseVersion(expected);
  return declared.some((version) => {
    if (version.trim() === expected.trim()) return true;
    const other = parseVersion(version);
    return parsed !== null && other !== null && compareVersions(parsed, other) === 0;
  });
}

const describeTransition = (transition: Transition) =>
  `${transition.before.join(", ") || "none"} → ${transition.after.join(", ") || "none"}`;

export function applyAccept(
  findings: Finding[],
  accept: DependencyAcceptEntry[],
  transitions: Map<Finding, Transition> = new Map(),
): { findings: Finding[]; usage: AcceptUsage[] } {
  const usage: AcceptUsage[] = accept.map((entry) => ({
    entry,
    count: 0,
    stale: [],
    acceptedBreaking: false,
  }));
  const isSamePackage = (entry: DependencyAcceptEntry, finding: Finding) =>
    getPackageKey(finding.scope as Ecosystem, entry.name) ===
    getPackageKey(finding.scope as Ecosystem, finding.subject);
  const accepted = findings.map((finding) => {
    const candidates = usage.filter(({ entry }) => entry.id === finding.id && isSamePackage(entry, finding));
    const transition = transitions.get(finding);
    const isMatch = ({ entry }: AcceptUsage) =>
      transition === undefined ||
      (isListedVersion(entry.from, transition.before) && isListedVersion(entry.to, transition.after));
    const match = candidates.find(isMatch);
    if (match === undefined) {
      for (const candidate of candidates) {
        if (transition !== undefined) candidate.stale.push(describeTransition(transition));
      }
      return finding;
    }
    match.count++;
    if (finding.id === "dependency-upgraded" && finding.class === "needs-action")
      match.acceptedBreaking = true;
    return { ...finding, accepted: { reason: match.entry.reason } };
  });
  return { findings: accepted, usage };
}
