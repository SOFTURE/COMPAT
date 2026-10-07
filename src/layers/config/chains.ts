import type { RefTree } from "../../git/ref-tree.js";
import type { Finding, FindingClass } from "../../model/finding.js";
import { CONFIG_LAYER, type KeyIndex, type SourcedDeclaration, toEvidence } from "./classify.js";
import type { ChainAcceptEntry, ConfigChain } from "./config.js";
import type { KeyIdentity } from "./keys.js";

export const CHAIN_FINDING_ID = "config-chain-missing";

export type ChainAcceptUsage = { entry: ChainAcceptEntry; count: number };

/** The keys of one source at both refs, by key identity. */
export type SourceIndexes = { base: KeyIndex; revision: KeyIndex };

export type CheckChainsOptions = {
  chains: ConfigChain[];
  /** Sources scanned at both refs; a source that failed is absent. */
  sources: ReadonlyMap<string, SourceIndexes>;
  revisionTree: RefTree;
};

/**
 * Compares the sources of each chain with each other in the revision: a key present in one member
 * must be present in every other. A chain whose member could not be scanned is skipped with a note,
 * because a source without data would make every key look missing.
 */
export function checkChains({ chains, sources, revisionTree }: CheckChainsOptions): {
  findings: Finding[];
  notes: string[];
} {
  const findings: Finding[] = [];
  const notes: string[] = [];
  for (const chain of chains) {
    const required = chain.required ?? [];
    const members = [...chain.sources, ...required];
    const indexes: Array<SourceIndexes & { member: string }> = [];
    const unscanned: string[] = [];
    for (const member of members) {
      const scanned = sources.get(member);
      if (scanned === undefined) unscanned.push(member);
      else indexes.push({ member, ...scanned });
    }
    if (unscanned.length > 0) {
      notes.push(`chain "${chain.name}" skipped: source(s) ${unscanned.join(", ")} could not be scanned`);
      continue;
    }
    const keys = new Set(indexes.flatMap(({ revision }) => [...revision.keys()]));
    for (const key of [...keys].sort(compareText)) {
      const present = indexes.filter(({ revision }) => revision.has(key));
      const missing = indexes.filter(({ revision }) => !revision.has(key)).map(({ member }) => member);
      if (missing.length === 0) continue;
      if (chain.scope === "changed" && !indexes.some((index) => isKeyChanged(index, key))) continue;
      const findingClass: FindingClass =
        chain.class ?? (missing.some((member) => required.includes(member)) ? "breaking" : "needs-action");
      const holders = present.map(({ member }) => member);
      findings.push({
        layer: CONFIG_LAYER,
        scope: `chain ${chain.name}`,
        id: CHAIN_FINDING_ID,
        subject: key,
        class: findingClass,
        message: `the key is in ${holders.join(", ")} but missing from ${missing.join(", ")}; every source of the chain must have it`,
        evidence: toEvidence(
          revisionTree,
          present.flatMap(({ revision }) => revision.get(key) ?? []),
        ),
      });
    }
  }
  return { findings, notes };
}

/** True when the declarations of a key in one source differ between the refs: added, removed or another default. */
function isKeyChanged({ base, revision }: SourceIndexes, key: string): boolean {
  return describeDeclarations(base.get(key)) !== describeDeclarations(revision.get(key));
}

function describeDeclarations(declarations: SourcedDeclaration[] | undefined): string {
  if (declarations === undefined || declarations.length === 0) return "absent";
  const defaults = declarations.map((declaration) => declaration.default ?? "\0required");
  return JSON.stringify([...new Set(defaults)].sort());
}

/** Marks chain findings matched by an accept entry (the same key identity and chain name). */
export function applyChainAccept(
  findings: Finding[],
  accept: ChainAcceptEntry[],
  identify: KeyIdentity,
): { findings: Finding[]; usage: ChainAcceptUsage[] } {
  const usage = accept.map((entry) => ({ entry, count: 0 }));
  const result = findings.map((finding) => {
    const match = usage.find(
      ({ entry }) => identify(entry.key) === finding.subject && `chain ${entry.chain}` === finding.scope,
    );
    if (match === undefined) return finding;
    match.count += 1;
    return { ...finding, accepted: { reason: match.entry.reason } };
  });
  return { findings: result, usage };
}

function compareText(a: string, b: string): number {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}
