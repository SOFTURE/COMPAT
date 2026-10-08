import type { RefTree } from "../../git/ref-tree.js";
import type { Evidence, Finding, LayerResult, Side } from "../../model/finding.js";
import { err, ok, type Result } from "../../result.js";
import { createLineLocator, stripComments } from "../config/comments.js";
import { defineLayer } from "../layer.js";
import { findBrokerUsage, type MessageUsage } from "./broker-usage.js";
import {
  buildContractIndex,
  type ContractChange,
  type ContractIndex,
  compareContracts,
  type LocatedEnum,
  type LocatedType,
  type Site,
} from "./compare-contracts.js";
import { type ComposedQueueNames, composeQueueParts, type QueueNames } from "./compose-queues.js";
import {
  type AcceptEntry,
  type ContractSource,
  compileQueuePattern,
  getPartSource,
  type MessageContractsConfig,
  messageContractsConfigSchema,
  type QueueSource,
  type RegexQueueSource,
} from "./config.js";
import { compareConsumers } from "./consumers.js";
import { parseContracts } from "./parse-contracts.js";

export const MESSAGE_CONTRACTS_LAYER = "message-contracts";

const READ_CONCURRENCY = 16;

type Sides = Record<Side, RefTree>;

/** What one source holds at one ref. */
type SourceScan = { files: string[]; types: LocatedType[]; enums: LocatedEnum[]; failures: string[] };

/** Queue names of one queue source at one ref, each with the first place it appears when there is one. */
type QueueScan = { files: string[]; queues: Map<string, Site | undefined> };

export const messageContractsLayer = defineLayer({
  name: MESSAGE_CONTRACTS_LAYER,
  description:
    "Message contracts (C# types, properties, enums) and queue names compared for messages in flight",
  configSchema: messageContractsConfigSchema,
  async run(context) {
    const sides: Sides = { base: context.base, revision: context.revision };
    const notes: string[] = [];
    const errors: string[] = [];
    const changes: ContractChange[] = [];

    const scans: Record<Side, SourceScan[]> = { base: [], revision: [] };
    for (const source of context.config.sources) {
      const scanned = await scanSourceAtBothRefs(source, sides);
      if (!scanned.ok) {
        errors.push(`source "${source.name}": ${scanned.error}`);
        continue;
      }
      const [atBase, atRevision] = scanned.value;
      errors.push(...checkSourceCoverage(source, atBase, atRevision));
      for (const [side, scan] of [
        ["base", atBase],
        ["revision", atRevision],
      ] as const) {
        scans[side].push(scan);
        errors.push(
          ...scan.failures.map((failure) => `source "${source.name}" at ${sides[side].ref}: ${failure}`),
        );
      }
      notes.push(
        `source "${source.name}": ${atBase.types.length} type(s) and ${atBase.enums.length} enum(s) in ${atBase.files.length} file(s) at the base, ` +
          `${atRevision.types.length} type(s) and ${atRevision.enums.length} enum(s) in ${atRevision.files.length} file(s) in the revision`,
      );
    }
    const indexes = {
      base: buildContractIndex(
        scans.base.flatMap((scan) => scan.types),
        scans.base.flatMap((scan) => scan.enums),
      ),
      revision: buildContractIndex(
        scans.revision.flatMap((scan) => scan.types),
        scans.revision.flatMap((scan) => scan.enums),
      ),
    };
    for (const side of ["base", "revision"] as const) {
      errors.push(...indexes[side].failures.map((failure) => `at ${sides[side].ref}: ${failure}`));
    }
    // A type the parser could not read at one ref must not read as added or removed.
    const unreadable = new Set(
      [...scans.base, ...scans.revision].flatMap((scan) => scan.failures.map(getFailureName)),
    );
    const compared = compareContracts(
      withoutNames(indexes.base, unreadable),
      withoutNames(indexes.revision, unreadable),
    );
    const ordered = await applyDeployOrder(compared, sides.revision);
    if (ordered.ok) {
      changes.push(...ordered.value.changes);
      notes.push(...ordered.value.notes);
    } else {
      changes.push(...compared);
      errors.push(`deploy order at ${sides.revision.ref}: ${ordered.error}`);
    }

    const queues = await scanAllQueues(context.config.queues ?? [], sides);
    errors.push(...queues.errors);
    changes.push(...queues.changes);
    notes.push(...queues.notes);

    const consumers = await compareConsumers({
      sources: context.config.consumers ?? [],
      sides,
      messages: getSharedMessageNames(indexes.base, indexes.revision),
      queues: queues.resolved,
      readFiles,
    });
    errors.push(...consumers.errors);
    changes.push(...consumers.changes);
    notes.push(...consumers.notes);

    const findings = changes.map((change) => toFinding(change, sides));
    const accepted = applyAccept(findings, context.config.accept ?? []);
    notes.push(...accepted.notes);
    if (errors.length > 0) {
      return {
        layer: MESSAGE_CONTRACTS_LAYER,
        status: "failed",
        error: errors.join("; "),
        findings: accepted.findings,
        notes,
      } satisfies LayerResult;
    }
    return {
      layer: MESSAGE_CONTRACTS_LAYER,
      status: "ran",
      findings: accepted.findings,
      notes,
    } satisfies LayerResult;
  },
});

const getSimpleName = (fullName: string) => fullName.split(/[.+]/).at(-1)?.replace(/`\d+$/, "") ?? fullName;

const formatProjects = (projects: Map<string, Site>) =>
  [...projects].map(([project, site]) => `${project} (${site.path}:${site.line})`).join(", ");

/** Whether publishers and consumers deploy separately: some publisher project is not the one consumer. */
function isDeployedApart(usage: MessageUsage | undefined): usage is MessageUsage {
  if (usage === undefined || usage.publishers.size === 0 || usage.consumers.size === 0) return false;
  const [publisher] = usage.publishers.keys();
  return !(
    usage.publishers.size === 1 &&
    usage.consumers.size === 1 &&
    usage.consumers.has(publisher as string)
  );
}

/**
 * A new message published by one project and consumed by another is `needs-action`: until the
 * consumer runs the revision its queue is not bound, and a publish to an unbound exchange is dropped.
 */
async function applyDeployOrder(
  changes: ContractChange[],
  revision: RefTree,
): Promise<Result<{ changes: ContractChange[]; notes: string[] }>> {
  const added = changes.filter((change) => change.id === "message-added");
  if (added.length === 0) return ok({ changes, notes: [] });
  const usages = await findBrokerUsage(
    revision,
    new Set(added.map((change) => getSimpleName(change.subject))),
  );
  if (!usages.ok) return usages;
  let apart = 0;
  const ordered = changes.map((change) => {
    if (change.id !== "message-added") return change;
    const usage = usages.value.get(getSimpleName(change.subject));
    if (!isDeployedApart(usage)) return change;
    apart += 1;
    return {
      ...change,
      class: "needs-action" as const,
      message:
        `the type is new in the revision, published by ${formatProjects(usage.publishers)} and consumed by ${formatProjects(usage.consumers)}: ` +
        "deploy the consumer (or declare its topology) before the publisher, or messages published in between are dropped; after a rollback, drain or delete its queue",
    };
  });
  return ok({
    changes: ordered,
    notes: [
      `deploy order: ${apart} of ${added.length} new message(s) published and consumed in different projects`,
    ],
  });
}

/** Simple names of the message types declared at both refs; a consumer of a new or removed type is not compared. */
function getSharedMessageNames(base: ContractIndex, revision: ContractIndex): Set<string> {
  const names = (index: ContractIndex) =>
    new Set([...index.types.values()].map((located) => getSimpleName(located.type.fullName)));
  const atRevision = names(revision);
  return new Set([...names(base)].filter((name) => atRevision.has(name)));
}

/** Failures are prefixed with the path and carry the quoted name the parser gave them. */
function getFailureName(failure: string): string {
  return /"([^"]+)"/.exec(failure)?.[1] ?? failure;
}

function withoutNames(index: ContractIndex, names: Set<string>): ContractIndex {
  if (names.size === 0) return index;
  const isUnreadable = (fullName: string) => {
    const simple = fullName.split(/[.+]/).at(-1)?.replace(/`\d+$/, "") ?? fullName;
    return names.has(fullName) || names.has(simple);
  };
  return {
    ...index,
    types: new Map([...index.types].filter(([, located]) => !isUnreadable(located.type.fullName))),
    enums: new Map([...index.enums].filter(([fullName]) => !isUnreadable(fullName))),
  };
}

async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  map: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await map(items[index] as T);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

/** Lists and reads the files matched by `globs`; `null` content (absent) is skipped. */
async function readFiles(tree: RefTree, globs: string | string[]): Promise<Result<[string, string][]>> {
  const listed = await tree.listFiles(globs);
  if (!listed.ok) return err(`cannot list files at ${tree.ref}: ${listed.error}`);
  const contents = await mapWithConcurrency(listed.value, READ_CONCURRENCY, (path) => tree.readFile(path));
  const files: [string, string][] = [];
  for (const [position, path] of listed.value.entries()) {
    const content = contents[position] as Result<string | null>;
    if (!content.ok) return err(content.error);
    if (content.value !== null) files.push([path, content.value]);
  }
  return ok(files);
}

async function scanSource(source: ContractSource, tree: RefTree): Promise<Result<SourceScan>> {
  const files = await readFiles(tree, source.files);
  if (!files.ok) return files;
  const scan: SourceScan = { files: [], types: [], enums: [], failures: [] };
  for (const [path, text] of files.value) {
    if (!path.toLowerCase().endsWith(".cs")) continue;
    scan.files.push(path);
    const parsed = parseContracts(text);
    scan.types.push(...parsed.types.map((type) => ({ source: source.name, path, type })));
    scan.enums.push(
      ...parsed.enums.map((contract) => ({
        source: source.name,
        path,
        storage: source.enumStorage,
        contract,
      })),
    );
    scan.failures.push(...parsed.failures.map((failure) => `${path}: ${failure.error}`));
  }
  return ok(scan);
}

async function scanSourceAtBothRefs(
  source: ContractSource,
  sides: Sides,
): Promise<Result<[SourceScan, SourceScan]>> {
  const base = await scanSource(source, sides.base);
  if (!base.ok) return base;
  const revision = await scanSource(source, sides.revision);
  if (!revision.ok) return revision;
  return ok([base.value, revision.value]);
}

/** A source that cannot speak for the revision fails the layer instead of reading as "nothing changed". */
function checkSourceCoverage(source: ContractSource, base: SourceScan, revision: SourceScan): string[] {
  const name = `source "${source.name}"`;
  if (base.files.length === 0 && revision.files.length === 0)
    return [`${name} matches no .cs file at either ref`];
  if (revision.files.length === 0) return [`${name} matches .cs files at the base but none in the revision`];
  const isEmpty = (scan: SourceScan) => scan.types.length === 0 && scan.enums.length === 0;
  if (isEmpty(base) && isEmpty(revision) && base.failures.length + revision.failures.length === 0) {
    return [`${name} declares no public type at either ref`];
  }
  return [];
}

type QueueOutcome = {
  errors: string[];
  changes: ContractChange[];
  notes: string[];
  /** The names every queue source that did not fail gives at each ref, for consumers with `queueFrom`. */
  resolved: Record<Side, Map<string, Map<string, string[]>>>;
};

/** Each name of a regex source is its own only value. */
const toResolved = (queues: QueueNames) => new Map([...queues.keys()].map((queue) => [queue, [queue]]));

/** Scans the regex queue sources, then builds the composed ones from what they found. */
async function scanAllQueues(sources: QueueSource[], sides: Sides): Promise<QueueOutcome> {
  const outcome: QueueOutcome = {
    errors: [],
    changes: [],
    notes: [],
    resolved: { base: new Map(), revision: new Map() },
  };
  const found: Record<Side, Map<string, QueueNames>> = { base: new Map(), revision: new Map() };
  const failed = new Set<string>();
  for (const source of sources) {
    if (source.kind !== "regex") continue;
    const scanned = await scanQueuesAtBothRefs(source, sides);
    if (!scanned.ok) {
      outcome.errors.push(`queue source "${source.name}": ${scanned.error}`);
      failed.add(source.name);
      continue;
    }
    const [atBase, atRevision] = scanned.value;
    found.base.set(source.name, atBase.queues);
    found.revision.set(source.name, atRevision.queues);
    outcome.resolved.base.set(source.name, toResolved(atBase.queues));
    outcome.resolved.revision.set(source.name, toResolved(atRevision.queues));
    outcome.errors.push(...checkQueueCoverage(source, atBase, atRevision));
    if (source.report) outcome.changes.push(...compareQueues(source, atBase, atRevision));
    outcome.notes.push(
      `queue source "${source.name}": ${atBase.queues.size} queue(s) at the base, ${atRevision.queues.size} in the revision` +
        (source.report ? "" : " (a part, not reported)"),
    );
  }
  for (const source of sources) {
    if (source.kind !== "composed") continue;
    const name = `queue source "${source.name}"`;
    const failedParts = Object.values(source.parts)
      .map(getPartSource)
      .filter((part) => part !== undefined && failed.has(part));
    if (failedParts.length > 0) {
      outcome.errors.push(`${name} is skipped: part source "${failedParts[0]}" failed`);
      continue;
    }
    const atBase = composeQueueParts(source, found.base);
    if (!atBase.ok) {
      outcome.errors.push(`${name} at ${sides.base.ref} ${atBase.error}`);
      continue;
    }
    const atRevision = composeQueueParts(source, found.revision);
    if (!atRevision.ok) {
      outcome.errors.push(`${name} at ${sides.revision.ref} ${atRevision.error}`);
      continue;
    }
    for (const [side, composed] of [
      ["base", atBase.value],
      ["revision", atRevision.value],
    ] as const) {
      outcome.resolved[side].set(
        source.name,
        new Map([...composed].map(([queue, { parts }]) => [queue, parts])),
      );
    }
    const toSites = (composed: ComposedQueueNames): QueueNames =>
      new Map([...composed].map(([queue, { site }]) => [queue, site]));
    const base: QueueScan = { files: [], queues: toSites(atBase.value) };
    const revision: QueueScan = { files: [], queues: toSites(atRevision.value) };
    outcome.errors.push(...checkQueueNames(name, base, revision));
    outcome.changes.push(...compareQueues(source, base, revision));
    outcome.notes.push(
      `${name}: ${base.queues.size} queue(s) at the base, ${revision.queues.size} in the revision`,
    );
  }
  return outcome;
}

async function scanQueues(source: RegexQueueSource, tree: RefTree): Promise<Result<QueueScan>> {
  const compiled = compileQueuePattern(source.pattern, source.flags);
  if ("error" in compiled) return err(`pattern ${compiled.error}`);
  const files = await readFiles(tree, source.files);
  if (!files.ok) return files;
  const scan: QueueScan = { files: [], queues: new Map() };
  for (const [path, text] of files.value) {
    scan.files.push(path);
    const stripped = stripComments(text, source.comments);
    const getLine = createLineLocator(stripped);
    for (const match of stripped.matchAll(compiled.regex)) {
      const hasNamedGroup = match.groups !== undefined && Object.hasOwn(match.groups, "queue");
      const queue = (hasNamedGroup ? match.groups?.queue : match[1])?.trim();
      if (queue === undefined || queue === "" || scan.queues.has(queue)) continue;
      const offset =
        (hasNamedGroup ? match.indices?.groups?.queue?.[0] : match.indices?.[1]?.[0]) ?? match.index;
      scan.queues.set(queue, { path, line: getLine(offset) });
    }
  }
  return ok(scan);
}

async function scanQueuesAtBothRefs(
  source: RegexQueueSource,
  sides: Sides,
): Promise<Result<[QueueScan, QueueScan]>> {
  const base = await scanQueues(source, sides.base);
  if (!base.ok) return base;
  const revision = await scanQueues(source, sides.revision);
  if (!revision.ok) return revision;
  return ok([base.value, revision.value]);
}

function checkQueueCoverage(source: RegexQueueSource, base: QueueScan, revision: QueueScan): string[] {
  const name = `queue source "${source.name}"`;
  if (base.files.length === 0 && revision.files.length === 0)
    return [`${name} matches no file at either ref`];
  if (revision.files.length === 0) return [`${name} matches files at the base but none in the revision`];
  // A part may find nothing at a ref (a setting left to its default); the composed source checks the names.
  return source.report ? checkQueueNames(name, base, revision) : [];
}

/** A queue source that finds nothing, or loses every queue in the revision, is misconfigured. */
function checkQueueNames(name: string, base: QueueScan, revision: QueueScan): string[] {
  if (base.queues.size === 0 && revision.queues.size === 0) return [`${name} finds no queue at either ref`];
  if (base.queues.size > 0 && revision.queues.size === 0)
    return [`${name} finds queues at the base but none in the revision`];
  return [];
}

function compareQueues(source: QueueSource, base: QueueScan, revision: QueueScan): ContractChange[] {
  const changes: ContractChange[] = [];
  for (const [queue, site] of base.queues) {
    if (revision.queues.has(queue)) continue;
    changes.push({
      id: "queue-removed",
      class: "needs-action",
      scope: source.name,
      subject: queue,
      message:
        "the revision no longer consumes this queue; drain it before the deploy or messages stay there",
      base: site,
    });
  }
  for (const [queue, site] of revision.queues) {
    if (base.queues.has(queue)) continue;
    changes.push({
      id: "queue-added",
      class: "rollback-risk",
      scope: source.name,
      subject: queue,
      message:
        "a new queue the base build does not consume: after a rollback, messages already in it or still routed to it stay there; drain or delete it",
      revision: site,
    });
  }
  return changes;
}

function toFinding(change: ContractChange, sides: Sides): Finding {
  const evidence: Evidence[] = [];
  for (const side of ["base", "revision"] as const) {
    const site = change[side];
    if (site === undefined) continue;
    evidence.push({
      side,
      ref: sides[side].ref,
      commit: sides[side].commit,
      path: site.path,
      line: site.line,
    });
  }
  return {
    layer: MESSAGE_CONTRACTS_LAYER,
    scope: change.scope,
    id: change.id,
    subject: change.subject,
    class: change.class,
    message: change.message,
    evidence,
  };
}

type AcceptOutcome = { findings: Finding[]; notes: string[] };

function applyAccept(findings: Finding[], accept: MessageContractsConfig["accept"] & {}): AcceptOutcome {
  const usage = accept.map(() => 0);
  const result = findings.map((finding) => {
    const position = accept.findIndex(
      (entry) => entry.id === finding.id && entry.subject === finding.subject,
    );
    if (position === -1) return finding;
    usage[position] = (usage[position] ?? 0) + 1;
    return { ...finding, accepted: { reason: (accept[position] as AcceptEntry).reason } };
  });
  const notes = accept.map((entry, position) => {
    const count = usage[position] ?? 0;
    return count === 0
      ? `accept entry ${entry.id} on ${entry.subject} matched nothing; remove it if the change is gone`
      : `accept entry ${entry.id} on ${entry.subject} accepted ${count} finding(s)`;
  });
  return { findings: result, notes };
}
