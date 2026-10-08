import type { FindingClass } from "../../model/finding.js";
import { compareEnums, type EnumStorage } from "../persisted-enums/compare-enums.js";
import type { EnumChangeId } from "../persisted-enums/config.js";
import type { ContractEnum, ContractProperty, ContractType } from "./parse-contracts.js";

export type Site = { path: string; line: number };

/** A contract type found in one file of one configured source. */
export type LocatedType = { source: string; path: string; type: ContractType };

export type LocatedEnum = { source: string; path: string; storage: EnumStorage; contract: ContractEnum };

/** One ref's contracts by identity, with inherited properties flattened in. */
export type ContractIndex = {
  /** By identity: the `[MessageUrn]` when set, else the full name. */
  types: Map<string, LocatedType>;
  enums: Map<string, LocatedEnum>;
  /** Types that cannot be compared, for example a full name declared twice without `partial`. */
  failures: string[];
};

export type ContractChangeId =
  | "message-added"
  | "message-removed"
  | "message-renamed"
  | "message-entity-name-changed"
  | "message-base-added"
  | "message-base-removed"
  | "message-property-added"
  | "message-property-removed"
  | "message-property-type-changed"
  | "message-property-nullability-changed"
  | "message-property-required"
  | "queue-added"
  | "queue-removed"
  | "message-consumer-moved"
  | "message-consumer-removed"
  | EnumChangeId;

export type ContractChange = {
  id: ContractChangeId;
  class: FindingClass;
  /** The source the change belongs to (the revision's for a rename). */
  scope: string;
  subject: string;
  message: string;
  base?: Site;
  revision?: Site;
};

const getIdentity = (type: ContractType) => type.urn ?? type.fullName;

const getWireKey = (property: ContractProperty) => property.wireName.toLowerCase();

/** Merges partial declarations, rejects other duplicates and flattens base types declared in the sources. */
export function buildContractIndex(types: LocatedType[], enums: LocatedEnum[]): ContractIndex {
  const failures: string[] = [];
  const byFullName = new Map<string, LocatedType[]>();
  for (const located of types) {
    byFullName.set(located.type.fullName, [...(byFullName.get(located.type.fullName) ?? []), located]);
  }
  const merged = new Map<string, LocatedType>();
  for (const [fullName, declarations] of byFullName) {
    const first = declarations[0] as LocatedType;
    if (declarations.length === 1) {
      merged.set(fullName, first);
      continue;
    }
    if (!declarations.every((located) => located.type.isPartial)) {
      const places = declarations.map((located) => `${located.path}:${located.type.line}`).join(", ");
      failures.push(`"${fullName}" is declared more than once without partial (${places})`);
      continue;
    }
    const properties = new Map<string, ContractProperty>();
    for (const located of declarations) {
      for (const property of located.type.properties) {
        if (!properties.has(getWireKey(property))) properties.set(getWireKey(property), property);
      }
    }
    merged.set(fullName, {
      ...first,
      type: {
        ...first.type,
        urn: declarations.find((located) => located.type.urn !== null)?.type.urn ?? null,
        entityName: declarations.find((located) => located.type.entityName !== null)?.type.entityName ?? null,
        baseTypes: [...new Set(declarations.flatMap((located) => located.type.baseTypes))],
        properties: [...properties.values()],
      },
    });
  }

  const flattened = new Map<string, ContractType>();
  const flatten = (located: LocatedType, visiting: Set<string>): ContractType => {
    const known = flattened.get(located.type.fullName);
    if (known !== undefined) return known;
    visiting.add(located.type.fullName);
    const properties = new Map(located.type.properties.map((property) => [getWireKey(property), property]));
    for (const baseType of located.type.baseTypes) {
      const base = resolveBaseType(baseType, located, merged);
      if (base === undefined || visiting.has(base.type.fullName)) continue;
      for (const property of flatten(base, visiting).properties) {
        // A member declared in the derived type wins over the inherited one.
        if (!properties.has(getWireKey(property))) properties.set(getWireKey(property), property);
      }
    }
    visiting.delete(located.type.fullName);
    const result = { ...located.type, properties: [...properties.values()] };
    flattened.set(located.type.fullName, result);
    return result;
  };

  const index: ContractIndex = { types: new Map(), enums: new Map(), failures };
  for (const located of merged.values()) {
    const type = flatten(located, new Set());
    const identity = getIdentity(type);
    const other = index.types.get(identity);
    if (other !== undefined) {
      failures.push(
        `"${type.fullName}" and "${other.type.fullName}" share the message identity "${identity}" (${other.path}, ${located.path})`,
      );
      continue;
    }
    index.types.set(identity, { ...located, type });
  }
  for (const located of enums) {
    const other = index.enums.get(located.contract.fullName);
    if (other !== undefined) {
      failures.push(
        `enum "${located.contract.fullName}" is declared more than once (${other.path}, ${located.path})`,
      );
      continue;
    }
    index.enums.set(located.contract.fullName, located);
  }
  return index;
}

/**
 * The type a base-list entry names, when exactly one type of the sources matches it: by full name
 * relative to the derived type's namespace, else by simple name. `undefined` when outside the sources.
 */
function resolveBaseType(
  baseType: string,
  derived: LocatedType,
  types: Map<string, LocatedType>,
): LocatedType | undefined {
  const genericStart = baseType.indexOf("<");
  const name = (genericStart === -1 ? baseType : baseType.slice(0, genericStart)).replace(/\?$/, "");
  const arity = genericStart === -1 ? 0 : countTypeArguments(baseType.slice(genericStart));
  const simple = `${name.split(".").at(-1)}${arity > 0 ? `\`${arity}` : ""}`;
  const qualified = `${name.includes(".") ? name.slice(0, name.lastIndexOf(".") + 1) : ""}${simple}`;
  const candidates = [...types.values()].filter(
    (candidate) =>
      candidate !== derived &&
      candidate.type.simpleName === simple &&
      (candidate.type.fullName === qualified ||
        candidate.type.fullName.endsWith(`.${qualified}`) ||
        candidate.type.fullName.endsWith(`+${qualified}`)),
  );
  if (candidates.length === 1) return candidates[0];
  // Several types share the simple name: prefer the one in the derived type's namespace.
  const namespace = derived.type.fullName.slice(0, derived.type.fullName.lastIndexOf(".") + 1);
  const local = candidates.filter((candidate) => candidate.type.fullName === `${namespace}${simple}`);
  return local.length === 1 ? local[0] : undefined;
}

function countTypeArguments(list: string): number {
  let depth = 0;
  let commas = 0;
  for (const char of list) {
    if (char === "<") depth++;
    else if (char === ">") depth--;
    else if (char === "," && depth === 1) commas++;
  }
  return commas + 1;
}

/** Compares the contracts of the two refs. Pure: the layer turns the changes into findings. */
export function compareContracts(base: ContractIndex, revision: ContractIndex): ContractChange[] {
  const changes: ContractChange[] = [];
  const removed = [...base.types.entries()].filter(([identity]) => !revision.types.has(identity));
  const added = [...revision.types.entries()].filter(([identity]) => !base.types.has(identity));
  const pairs = pairRenames(
    removed.map(([, located]) => located),
    added.map(([, located]) => located),
  );
  const paired = new Set(pairs.values());
  const kinds = collectTypeKinds(base, revision);

  for (const [identity, old] of base.types) {
    const current = revision.types.get(identity) ?? pairs.get(old);
    if (current === undefined) {
      changes.push({
        id: "message-removed",
        class: "needs-action",
        scope: old.source,
        subject: old.type.fullName,
        message:
          "the type is gone from the revision; drain its queues before the deploy, because messages the base build published can no longer be consumed",
        base: { path: old.path, line: old.type.line },
      });
      continue;
    }
    if (!revision.types.has(identity)) {
      changes.push({
        id: "message-renamed",
        class: "breaking",
        scope: current.source,
        subject: `${old.type.fullName} -> ${current.type.fullName}`,
        message:
          "the message identity (URN) changed: messages in flight and messages from the other build are no longer delivered to its consumers",
        base: { path: old.path, line: old.type.line },
        revision: { path: current.path, line: current.type.line },
      });
    }
    changes.push(...compareType(old, current, kinds));
  }
  for (const [, located] of added) {
    if (paired.has(located)) continue;
    changes.push({
      id: "message-added",
      class: "safe",
      scope: located.source,
      subject: located.type.fullName,
      message: "the type is new in the revision; no message of the base build uses it",
      revision: { path: located.path, line: located.type.line },
    });
  }
  changes.push(...compareEnumIndexes(base, revision));
  return changes;
}

/**
 * Pairs a removed type with an added one when they are the only ones with that simple name, or
 * else the only ones with that non-empty wire shape (a type moved to another namespace).
 */
function pairRenames(removed: LocatedType[], added: LocatedType[]): Map<LocatedType, LocatedType> {
  const pairs = new Map<LocatedType, LocatedType>();
  const tryPair = (getKey: (located: LocatedType) => string | null) => {
    const group = (list: LocatedType[]) => {
      const groups = new Map<string, LocatedType[]>();
      for (const located of list) {
        const key = getKey(located);
        if (key !== null) groups.set(key, [...(groups.get(key) ?? []), located]);
      }
      return groups;
    };
    const pairedAdded = new Set(pairs.values());
    const removedGroups = group(removed.filter((located) => !pairs.has(located)));
    const addedGroups = group(added.filter((located) => !pairedAdded.has(located)));
    for (const [key, olds] of removedGroups) {
      const news = addedGroups.get(key);
      if (olds.length === 1 && news?.length === 1) pairs.set(olds[0] as LocatedType, news[0] as LocatedType);
    }
  };
  tryPair((located) => located.type.simpleName);
  tryPair((located) =>
    located.type.properties.length === 0
      ? null
      : located.type.properties
          .map((property) => `${getWireKey(property)}:${property.type}`)
          .sort()
          .join(";"),
  );
  return pairs;
}

const stripNullable = (type: string) => type.replace(/\?$/, "");

type TypeKind = "value" | "reference";

/** Value types by normalized name: the C# keywords and the BCL structs a message usually carries. */
const VALUE_TYPES = new Set([
  "bool",
  "byte",
  "sbyte",
  "char",
  "short",
  "ushort",
  "int",
  "uint",
  "long",
  "ulong",
  "nint",
  "nuint",
  "float",
  "double",
  "decimal",
  "DateTime",
  "DateTimeOffset",
  "DateOnly",
  "TimeOnly",
  "TimeSpan",
  "Guid",
  "Half",
  "Int128",
  "UInt128",
]);

const REFERENCE_TYPES = new Set(["string", "object", "dynamic", "Uri", "Version"]);

/** Generic types that are structs; any other generic type is read as a class or interface. */
const GENERIC_VALUE_TYPES = new Set(["ValueTuple", "KeyValuePair", "Nullable", "Memory", "ReadOnlyMemory"]);

/**
 * Kinds of the types declared in the sources of both refs, by simple name without arity.
 * A name declared with both kinds is left out, so it reads as unknown.
 */
function collectTypeKinds(base: ContractIndex, revision: ContractIndex): Map<string, TypeKind | null> {
  const kinds = new Map<string, TypeKind | null>();
  const add = (fullName: string, kind: TypeKind) => {
    const name = fullName.split(/[.+]/).at(-1)?.replace(/`\d+$/, "") ?? fullName;
    const known = kinds.get(name);
    kinds.set(name, known === undefined || known === kind ? kind : null);
  };
  for (const index of [base, revision]) {
    for (const { type } of index.types.values()) {
      add(type.fullName, type.kind === "struct" || type.kind === "record struct" ? "value" : "reference");
    }
    for (const fullName of index.enums.keys()) add(fullName, "value");
  }
  return kinds;
}

/** Whether a normalized type (without its trailing `?`) is a value or reference type; `null` when unknown. */
function getTypeKind(type: string, declared: Map<string, TypeKind | null>): TypeKind | null {
  if (type.startsWith("(")) return "value";
  if (type.endsWith("]")) return "reference";
  const genericStart = type.indexOf("<");
  const name = (genericStart === -1 ? type : type.slice(0, genericStart)).split(".").at(-1) ?? type;
  if (genericStart !== -1) return GENERIC_VALUE_TYPES.has(name) ? "value" : "reference";
  if (VALUE_TYPES.has(name)) return "value";
  if (REFERENCE_TYPES.has(name)) return "reference";
  return declared.get(name) ?? null;
}

const NULLABILITY_RISKS: Record<TypeKind | "unknown", string> = {
  value: "a null sent by one build fails to deserialize or reads as a default in the other",
  reference:
    "a null sent by one build still deserializes in the other (nullable reference annotations are not enforced); code there that dereferences it throws",
  unknown:
    "a null sent by one build fails to deserialize or reads as a default in the other for a value type, and for a reference type deserializes but throws where code dereferences it",
};

function compareType(
  old: LocatedType,
  current: LocatedType,
  kinds: Map<string, TypeKind | null>,
): ContractChange[] {
  const changes: ContractChange[] = [];
  const name = current.type.fullName;
  const scope = current.source;
  const typeSites = {
    base: { path: old.path, line: old.type.line },
    revision: { path: current.path, line: current.type.line },
  };
  if (old.type.entityName !== current.type.entityName) {
    changes.push({
      id: "message-entity-name-changed",
      class: "breaking",
      scope,
      subject: name,
      message: `[EntityName] changed from ${JSON.stringify(old.type.entityName)} to ${JSON.stringify(current.type.entityName)}: the builds publish to different exchanges`,
      ...typeSites,
    });
  }
  const baseTypes = new Set(old.type.baseTypes);
  const revisionTypes = new Set(current.type.baseTypes);
  for (const baseType of old.type.baseTypes) {
    if (revisionTypes.has(baseType)) continue;
    changes.push({
      id: "message-base-removed",
      class: "breaking",
      scope,
      subject: `${name} : ${baseType}`,
      message: `no longer derives from ${baseType}: consumers subscribed to ${baseType} stop receiving it`,
      ...typeSites,
    });
  }
  for (const baseType of current.type.baseTypes) {
    if (baseTypes.has(baseType)) continue;
    changes.push({
      id: "message-base-added",
      class: "safe",
      scope,
      subject: `${name} : ${baseType}`,
      message: `now also derives from ${baseType}; only consumers of the revision subscribe to it through this type`,
      ...typeSites,
    });
  }

  const revisionProperties = new Map(
    current.type.properties.map((property) => [getWireKey(property), property]),
  );
  const baseProperties = new Map(old.type.properties.map((property) => [getWireKey(property), property]));
  for (const property of old.type.properties) {
    const site = { path: old.path, line: property.line };
    const next = revisionProperties.get(getWireKey(property));
    if (next === undefined) {
      changes.push({
        id: "message-property-removed",
        class: "breaking",
        scope,
        subject: `${name}.${property.name}`,
        message: `"${property.wireName}" is no longer on the wire: consumers of the base build lose its value`,
        base: site,
      });
      continue;
    }
    const revisionSite = { path: current.path, line: next.line };
    if (!property.isRequired && next.isRequired) {
      changes.push({
        id: "message-property-required",
        class: "breaking",
        scope,
        subject: `${name}.${next.name}`,
        message: `"${next.wireName}" became required: base-build messages that leave it out (null values are omitted) fail to deserialize in the revision`,
        base: site,
        revision: revisionSite,
      });
    }
    if (property.type === next.type) continue;
    const isNullabilityOnly = stripNullable(property.type) === stripNullable(next.type);
    changes.push({
      id: isNullabilityOnly ? "message-property-nullability-changed" : "message-property-type-changed",
      class: isNullabilityOnly ? "rollback-risk" : "breaking",
      scope,
      subject: `${name}.${next.name}`,
      message: isNullabilityOnly
        ? `${property.type} -> ${next.type}: ${NULLABILITY_RISKS[getTypeKind(stripNullable(next.type), kinds) ?? "unknown"]}`
        : `${property.type} -> ${next.type}: messages of one build may not deserialize in the other`,
      base: site,
      revision: revisionSite,
    });
  }
  for (const property of current.type.properties) {
    if (baseProperties.has(getWireKey(property))) continue;
    changes.push({
      ...classifyAddedProperty(property),
      scope,
      subject: `${name}.${property.name}`,
      revision: { path: current.path, line: property.line },
    });
  }
  return changes;
}

function classifyAddedProperty(property: ContractProperty): Pick<ContractChange, "id" | "class" | "message"> {
  const id = "message-property-added";
  if (property.isRequired) {
    return {
      id,
      class: "breaking",
      message: `"${property.wireName}" is required: messages of the base build lack it and fail to deserialize in the revision`,
    };
  }
  if (property.type.endsWith("?") || property.hasDefault) {
    return {
      id,
      class: "safe",
      message: `"${property.wireName}" is optional: the base build ignores it, and messages without it read as ${property.hasDefault ? "the default" : "null"}`,
    };
  }
  return {
    id,
    class: "rollback-risk",
    message: `"${property.wireName}" is neither nullable nor defaulted: messages of the base build lack it and read as default(${property.type}) in the revision`,
  };
}

/** Enums of the sources, compared with the persisted-enums rules under the source's storage. */
function compareEnumIndexes(base: ContractIndex, revision: ContractIndex): ContractChange[] {
  const changes: ContractChange[] = [];
  for (const [fullName, old] of base.enums) {
    const current = revision.enums.get(fullName);
    if (current === undefined) {
      changes.push({
        id: "enum-removed",
        class: "needs-action",
        scope: old.source,
        subject: fullName,
        message: "the enum is no longer declared; check that no message in flight still carries it",
        base: { path: old.path, line: old.contract.declaration.line },
      });
      continue;
    }
    for (const change of compareEnums({
      enumName: fullName,
      storage: current.storage,
      base: old.contract.declaration,
      revision: current.contract.declaration,
    })) {
      changes.push({
        id: change.id,
        class: change.class,
        scope: current.source,
        subject: change.subject,
        message: `${current.storage} serialization: ${change.message.replace(/\brows?\b/g, (word) => (word === "row" ? "message" : "messages"))}`,
        ...(change.base ? { base: { path: old.path, line: change.base.line } } : {}),
        ...(change.revision ? { revision: { path: current.path, line: change.revision.line } } : {}),
      });
    }
  }
  for (const [fullName, current] of revision.enums) {
    if (base.enums.has(fullName)) continue;
    changes.push({
      id: "enum-added",
      class: "safe",
      scope: current.source,
      subject: fullName,
      message: "the enum is new in the revision",
      revision: { path: current.path, line: current.contract.declaration.line },
    });
  }
  return changes;
}
