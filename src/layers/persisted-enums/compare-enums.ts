import type { FindingClass } from "../../model/finding.js";
import type { EnumDeclaration, EnumMember } from "./parse-enums.js";

export const ENUM_STORAGES = ["string", "int"] as const;

export type EnumStorage = (typeof ENUM_STORAGES)[number];

export const MEMBER_CHANGE_IDS = [
  "enum-member-added",
  "enum-member-removed",
  "enum-member-renamed",
  "enum-member-renumbered",
  "enum-member-unresolved",
] as const;

export type MemberChangeId = (typeof MEMBER_CHANGE_IDS)[number];

export type MemberChange = {
  id: MemberChangeId;
  class: FindingClass;
  /** `Enum.Member`, or `Enum.Old -> Enum.New` for a rename. */
  subject: string;
  message: string;
  /** Member names involved, at either ref; the accept allowlist matches on them. */
  members: string[];
  base?: EnumMember;
  revision?: EnumMember;
};

export type CompareEnumsOptions = {
  enumName: string;
  storage: EnumStorage;
  base: EnumDeclaration;
  revision: EnumDeclaration;
};

/** Compares one persisted enum between the refs. Pure: the layer turns the changes into findings. */
export function compareEnums(options: CompareEnumsOptions): MemberChange[] {
  return options.storage === "string" ? compareStringStorage(options) : compareIntStorage(options);
}

/** What a row holds under string storage: the value of a TypeScript string member, else the name. */
function getStringKey(member: EnumMember): string {
  return member.stringValue ?? member.name;
}

function compareStringStorage({ enumName, base, revision }: CompareEnumsOptions): MemberChange[] {
  const revisionKeys = new Set(revision.members.map(getStringKey));
  const baseKeys = new Set(base.members.map(getStringKey));
  const removed = base.members.filter((member) => !revisionKeys.has(getStringKey(member)));
  const added = revision.members.filter((member) => !baseKeys.has(getStringKey(member)));

  const pairs = new Map<EnumMember, EnumMember>();
  const paired = new Set<EnumMember>();
  const pairBy = (matches: (old: EnumMember, renamed: EnumMember) => boolean) => {
    for (const old of removed) {
      if (pairs.has(old)) continue;
      const renamed = added.find((candidate) => !paired.has(candidate) && matches(old, candidate));
      if (renamed === undefined) continue;
      pairs.set(old, renamed);
      paired.add(renamed);
    }
  };
  // A changed string value under the same name first, then a new name under the same number.
  pairBy((old, renamed) => old.name === renamed.name);
  pairBy(
    (old, renamed) =>
      old.stringValue === null &&
      renamed.stringValue === null &&
      old.value !== null &&
      old.value === renamed.value,
  );

  const changes: MemberChange[] = [];
  for (const old of removed) {
    const renamed = pairs.get(old);
    if (renamed === undefined) {
      changes.push({
        id: "enum-member-removed",
        class: "breaking",
        subject: `${enumName}.${old.name}`,
        message: `rows that hold "${getStringKey(old)}" cannot be read by the revision build`,
        members: [old.name],
        base: old,
      });
      continue;
    }
    const subject =
      old.name === renamed.name
        ? `${enumName}.${old.name} (${JSON.stringify(getStringKey(old))} -> ${JSON.stringify(getStringKey(renamed))})`
        : `${enumName}.${old.name} -> ${enumName}.${renamed.name}`;
    changes.push({
      id: "enum-member-renamed",
      class: "breaking",
      subject,
      message:
        `stored as "${getStringKey(old)}" at the base and "${getStringKey(renamed)}" in the revision: ` +
        "existing rows cannot be read by the revision build, and new rows cannot be read by the base build",
      members: [...new Set([old.name, renamed.name])],
      base: old,
      revision: renamed,
    });
  }
  for (const member of added) {
    if (paired.has(member)) continue;
    changes.push(createAdded(enumName, member, `"${getStringKey(member)}"`));
  }
  return changes;
}

function createAdded(enumName: string, member: EnumMember, stored: string): MemberChange {
  return {
    id: "enum-member-added",
    class: "rollback-risk",
    subject: `${enumName}.${member.name}`,
    message: `${stored} is new: once a row holds it, the base build cannot read that row after a rollback`,
    members: [member.name],
    revision: member,
  };
}

function groupByValue(members: EnumMember[]): Map<bigint, EnumMember[]> {
  const groups = new Map<bigint, EnumMember[]>();
  for (const member of members) {
    if (member.value === null) continue;
    groups.set(member.value, [...(groups.get(member.value) ?? []), member]);
  }
  return groups;
}

function compareIntStorage({ enumName, base, revision }: CompareEnumsOptions): MemberChange[] {
  const changes: MemberChange[] = [];
  const baseByName = new Map(base.members.map((member) => [member.name, member]));
  const revisionNames = new Set(revision.members.map((member) => member.name));

  const renumbered = new Set<string>();
  for (const member of revision.members) {
    const old = baseByName.get(member.name);
    if (old?.value == null || member.value === null || old.value === member.value) continue;
    renumbered.add(member.name);
    changes.push({
      id: "enum-member-renumbered",
      class: "breaking",
      subject: `${enumName}.${member.name}`,
      message: `stored as ${old.value} at the base and ${member.value} in the revision: existing rows change meaning`,
      members: [member.name],
      base: old,
      revision: member,
    });
  }
  const isRenumbered = (member: EnumMember) => renumbered.has(member.name);
  // A member whose value is unknown on the other side is reported once, as unresolved.
  const unknownAtBase = new Set(base.members.filter((m) => m.value === null).map((m) => m.name));
  const unknownAtRevision = new Set(revision.members.filter((m) => m.value === null).map((m) => m.name));

  const baseValues = groupByValue(base.members);
  const revisionValues = groupByValue(revision.members);
  for (const [value, olds] of baseValues) {
    const currents = revisionValues.get(value);
    if (currents === undefined) {
      const old = olds.find((member) => !isRenumbered(member) && !unknownAtRevision.has(member.name));
      if (old === undefined) continue;
      changes.push({
        id: "enum-member-removed",
        class: "breaking",
        subject: `${enumName}.${old.name}`,
        message: `rows that hold ${value} have no member in the revision build`,
        members: olds.map((member) => member.name),
        base: old,
      });
      continue;
    }
    const isSameName = olds.some((old) => currents.some((current) => current.name === old.name));
    const gone = olds.filter((old) => !revisionNames.has(old.name));
    const old = gone[0];
    if (isSameName || old === undefined || olds.every(isRenumbered)) continue;
    const current = currents[0] as EnumMember;
    if (currents.every(isRenumbered)) {
      changes.push({
        id: "enum-member-removed",
        class: "breaking",
        subject: `${enumName}.${old.name}`,
        message: `rows that hold ${value} meant ${old.name} at the base and mean ${current.name} in the revision`,
        members: [old.name, current.name],
        base: old,
        revision: current,
      });
      continue;
    }
    changes.push({
      id: "enum-member-renamed",
      class: "needs-action",
      subject: `${enumName}.${old.name} -> ${enumName}.${current.name}`,
      message: `value ${value} is ${old.name} at the base and ${current.name} in the revision; rows stay readable, confirm the meaning did not change`,
      members: [old.name, current.name],
      base: old,
      revision: current,
    });
  }
  for (const [value, currents] of revisionValues) {
    if (baseValues.has(value)) continue;
    const current = currents.find((member) => !isRenumbered(member) && !unknownAtBase.has(member.name));
    if (current === undefined) continue;
    changes.push(createAdded(enumName, current, String(value)));
  }

  changes.push(...findUnresolved(enumName, base, revision));
  return changes;
}

/**
 * Members whose number the parser cannot compute. They are compared by how they are declared:
 * the initializer text, or for an implicit value, the chain back to the last explicit one.
 */
function findUnresolved(enumName: string, base: EnumDeclaration, revision: EnumDeclaration): MemberChange[] {
  const baseSignatures = getSignatures(base);
  const revisionSignatures = getSignatures(revision);
  const baseByName = new Map(base.members.map((member) => [member.name, member]));
  const revisionByName = new Map(revision.members.map((member) => [member.name, member]));
  const names = [
    ...revision.members.map((member) => member.name),
    ...base.members.map((member) => member.name).filter((name) => !revisionByName.has(name)),
  ];
  const changes: MemberChange[] = [];
  for (const name of names) {
    const old = baseByName.get(name);
    const current = revisionByName.get(name);
    if (old?.value != null && current?.value != null) continue;
    if (old === undefined && current?.value != null) continue;
    if (current === undefined && old?.value != null) continue;
    if (
      old !== undefined &&
      current !== undefined &&
      baseSignatures.get(old) === revisionSignatures.get(current)
    ) {
      continue;
    }
    changes.push({
      id: "enum-member-unresolved",
      class: "needs-action",
      subject: `${enumName}.${name}`,
      message: `the stored number of ${name} cannot be computed without a compiler and its declaration changed; check it by hand`,
      members: [name],
      ...(old ? { base: old } : {}),
      ...(current ? { revision: current } : {}),
    });
  }
  return changes;
}

function getSignatures(declaration: EnumDeclaration): Map<EnumMember, string> {
  const signatures = new Map<EnumMember, string>();
  let previous = "-1";
  for (const member of declaration.members) {
    const signature = member.valueText ?? `(${previous})+1`;
    signatures.set(member, signature);
    previous = signature;
  }
  return signatures;
}
