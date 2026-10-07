import type { RefTree } from "../../git/ref-tree.js";
import type { Evidence, Finding, LayerResult, Side } from "../../model/finding.js";
import { err, ok, type Result } from "../../result.js";
import { createLineLocator, stripComments } from "../config/comments.js";
import { defineLayer } from "../layer.js";
import {
  buildContractIndex,
  type ContractChange,
  type ContractIndex,
  compareContracts,
  type LocatedEnum,
  type LocatedType,
  type Site,
} from "./compare-contracts.js";
import {
  type AcceptEntry,
  type ContractSource,
  compileQueuePattern,
  type MessageContractsConfig,
  messageContractsConfigSchema,
  type QueueSource,
} from "./config.js";
import { parseContracts } from "./parse-contracts.js";

export const MESSAGE_CONTRACTS_LAYER = "message-contracts";

const READ_CONCURRENCY = 16;

type Sides = Record<Side, RefTree>;

/** What one source holds at one ref. */
type SourceScan = { files: string[]; types: LocatedType[]; enums: LocatedEnum[]; failures: string[] };

/** Queue names of one queue source at one ref, each with the first place it appears. */
type QueueScan = { files: string[]; queues: Map<string, Site> };

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
    changes.push(
      ...compareContracts(withoutNames(indexes.base, unreadable), withoutNames(indexes.revision, unreadable)),
    );

    for (const source of context.config.queues ?? []) {
      const scanned = await scanQueuesAtBothRefs(source, sides);
      if (!scanned.ok) {
        errors.push(`queue source "${source.name}": ${scanned.error}`);
        continue;
      }
      const [atBase, atRevision] = scanned.value;
      errors.push(...checkQueueCoverage(source, atBase, atRevision));
      changes.push(...compareQueues(source, atBase, atRevision));
      notes.push(
        `queue source "${source.name}": ${atBase.queues.size} queue(s) at the base, ${atRevision.queues.size} in the revision`,
      );
    }

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

async function scanQueues(source: QueueSource, tree: RefTree): Promise<Result<QueueScan>> {
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
  source: QueueSource,
  sides: Sides,
): Promise<Result<[QueueScan, QueueScan]>> {
  const base = await scanQueues(source, sides.base);
  if (!base.ok) return base;
  const revision = await scanQueues(source, sides.revision);
  if (!revision.ok) return revision;
  return ok([base.value, revision.value]);
}

function checkQueueCoverage(source: QueueSource, base: QueueScan, revision: QueueScan): string[] {
  const name = `queue source "${source.name}"`;
  if (base.files.length === 0 && revision.files.length === 0)
    return [`${name} matches no file at either ref`];
  if (revision.files.length === 0) return [`${name} matches files at the base but none in the revision`];
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
      class: "safe",
      scope: source.name,
      subject: queue,
      message: "a new queue; the base build neither publishes to it nor consumes it",
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
