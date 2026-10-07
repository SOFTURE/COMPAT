import type { Finding, LayerResult } from "../../model/finding.js";
import type { FindingRevision } from "../layer.js";
import { ROW_ADDED_SAFE_CLAUSE, SEED_LAYER } from "../seed/classify.js";
import { ADDED_MEMBER_CLAUSE } from "./compare-enums.js";
import { PERSISTED_ENUMS_LAYER } from "./persisted-enums-layer.js";

/** An `enum-member-added` finding of a string-stored enum, with the value its rows hold. */
export type AddedStringMember = { index: number; enumName: string; member: string; storedValue: string };

type SeedMatch = { index: number; finding: Finding; members: AddedStringMember[] };

/** Seed findings whose rows write the stored value of a member new in the revision. */
function findSeedMatches(results: readonly LayerResult[], added: AddedStringMember[]): SeedMatch[] {
  const seed = results.find((result) => result.layer === SEED_LAYER);
  if (seed === undefined || seed.status === "skipped") return [];
  return seed.findings.flatMap((finding, index) => {
    const literals = new Set(finding.literals ?? []);
    const members = added.filter((member) => literals.has(member.storedValue));
    return members.length === 0 ? [] : [{ index, finding, members }];
  });
}

function describeMembers(members: AddedStringMember[]): string {
  const byEnum = new Map<string, string[]>();
  for (const { enumName, member } of members) byEnum.set(enumName, [...(byEnum.get(enumName) ?? []), member]);
  return [...byEnum]
    .map(([enumName, names]) => `${enumName} member${names.length > 1 ? "s" : ""} ${names.join(", ")}`)
    .join(" and ");
}

/**
 * Correlates added string-stored members with the seed rows that write them: the seed findings
 * become rollback-risk (a base build fails on those rows after a rollback), and the member
 * findings say the seed writes the value on deploy. Returns the updated member findings and the
 * revisions of the seed findings.
 */
export function refineSeedFindings(
  findings: Finding[],
  added: AddedStringMember[],
  results: readonly LayerResult[],
): { findings: Finding[]; revisions: FindingRevision[] } {
  const matches = findSeedMatches(results, added);
  const updated = [...findings];
  const revisions: FindingRevision[] = [];
  for (const { index, finding, members } of matches) {
    const reason = `writes ${describeMembers(members)}, new in the revision`;
    revisions.push({
      layer: SEED_LAYER,
      index,
      finding: {
        ...finding,
        // Only `row-added` (safe) and `row-changed` (needs-action) carry literals, so this raises the class.
        class: "rollback-risk",
        message: `${finding.message.replace(ROW_ADDED_SAFE_CLAUSE, "")}; ${reason}: a base build that reads this table fails after a rollback`,
        evidence: [
          ...finding.evidence,
          ...members.flatMap((member) => findings[member.index]?.evidence.slice(0, 1) ?? []),
        ],
        reclassified: { from: finding.class, by: PERSISTED_ENUMS_LAYER, reason },
      },
    });
  }
  for (const member of added) {
    const rows = matches.filter((match) => match.members.includes(member));
    const original = updated[member.index];
    if (rows.length === 0 || original === undefined) continue;
    updated[member.index] = {
      ...original,
      message: original.message.replace(
        ADDED_MEMBER_CLAUSE,
        "the seed writes it on deploy, so the base build cannot read those rows after a rollback",
      ),
      evidence: [...original.evidence, ...rows.flatMap((match) => match.finding.evidence.slice(0, 1))],
    };
  }
  return { findings: updated, revisions };
}
