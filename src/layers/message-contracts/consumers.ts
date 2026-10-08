import type { RefTree } from "../../git/ref-tree.js";
import type { Side } from "../../model/finding.js";
import { err, ok, type Result } from "../../result.js";
import { createLineLocator, stripComments } from "../config/comments.js";
import type { ContractChange, Site } from "./compare-contracts.js";
import { type ConsumerSource, compileConsumerPattern } from "./config.js";

/** Where one message is consumed at one ref: queue name → the source and first place that says so. */
type MessageQueues = Map<string, { source: string; site: Site }>;

/** Which queue consumes which message at one ref, by the message's simple name. */
export type ConsumerMap = Map<string, MessageQueues>;

type SourceScan = { files: number; messages: number };

export type ConsumerOutcome = { changes: ContractChange[]; notes: string[]; errors: string[] };

type ReadFiles = (tree: RefTree, globs: string | string[]) => Promise<Result<[string, string][]>>;

/**
 * The queue names each queue source gives at one ref, each with the values it was built from: the part values of a
 * `composed` source, the name itself for a `regex` one. A source that failed is missing.
 */
export type ResolvedQueues = ReadonlyMap<string, ReadonlyMap<string, readonly string[]>>;

/**
 * The queue a consumer source reads from at one ref: its literal `queue`, or the one name its `queueFrom` source
 * gives there, narrowed by `select` to the names with a value equal to it. No name or several fail closed.
 */
export function resolveConsumerQueue(
  source: ConsumerSource,
  queues: ResolvedQueues,
  ref: string,
): Result<string> {
  if (source.queueFrom === undefined) {
    // The config schema requires `queue` when `queueFrom` is missing.
    if (source.queue === undefined) throw new Error(`consumer source "${source.name}" has no queue`);
    return ok(source.queue);
  }
  const name = `consumer source "${source.name}"`;
  const names = queues.get(source.queueFrom);
  if (names === undefined) return err(`${name} is skipped: queue source "${source.queueFrom}" failed`);
  const { select } = source;
  const candidates = [...names]
    .filter(([, values]) => select === undefined || values.includes(select))
    .map(([queue]) => queue);
  const what = `queue source "${source.queueFrom}"${select === undefined ? "" : ` with select "${select}"`}`;
  if (candidates.length === 0) return err(`${name}: ${what} gives no queue name at ${ref}`);
  if (candidates.length > 1) {
    return err(
      `${name}: ${what} gives ${candidates.length} queue names at ${ref} (${candidates.join(", ")}); ` +
        "set select to pick one",
    );
  }
  return ok(candidates[0] as string);
}

/** Resolves the queue of every consumer source at one ref, or gives every reason it cannot. */
function resolveConsumerQueues(
  sources: ConsumerSource[],
  queues: ResolvedQueues,
  ref: string,
): Result<Map<string, string>, string[]> {
  const resolved = new Map<string, string>();
  const errors: string[] = [];
  for (const source of sources) {
    const queue = resolveConsumerQueue(source, queues, ref);
    if (queue.ok) resolved.set(source.name, queue.value);
    else errors.push(queue.error);
  }
  return errors.length > 0 ? err(errors) : ok(resolved);
}

function describeRemaining(queues: MessageQueues): string {
  return queues.size === 0 ? "no consumer left" : `still consumed from ${[...queues.keys()].join(", ")}`;
}

/** `Ns.Outer+OrderPlaced` and `OrderPlaced` both read as `OrderPlaced`. */
export function getSimpleMessageName(name: string): string {
  return name.split(/[.+]/).at(-1)?.replace(/`\d+$/, "") ?? name;
}

/**
 * Reads every consumer source at one ref into one map. A source skips the files of the sources it excludes, so a
 * catch-all source (`Consumers/**`) can leave a consumer group's folder to that group's own source.
 */
async function scanConsumers(
  sources: ConsumerSource[],
  queueOf: ReadonlyMap<string, string>,
  tree: RefTree,
  readFiles: ReadFiles,
): Promise<Result<{ map: ConsumerMap; scans: Map<string, SourceScan> }>> {
  const filesBySource = new Map<string, [string, string][]>();
  for (const source of sources) {
    const files = await readFiles(tree, source.files);
    if (!files.ok) return err(`consumer source "${source.name}": ${files.error}`);
    filesBySource.set(source.name, files.value);
  }
  const map: ConsumerMap = new Map();
  const scans = new Map<string, SourceScan>();
  for (const source of sources) {
    const excluded = new Set(
      (source.exclude ?? []).flatMap((name) => (filesBySource.get(name) ?? []).map(([path]) => path)),
    );
    const files = (filesBySource.get(source.name) ?? []).filter(([path]) => !excluded.has(path));
    const compiled = compileConsumerPattern(source.pattern, source.flags);
    // The config schema already rejected a pattern that does not compile.
    if ("error" in compiled) throw new Error(`consumer pattern ${source.pattern} ${compiled.error}`);
    const queue = queueOf.get(source.name);
    // Every source's queue is resolved before the scan.
    if (queue === undefined) throw new Error(`consumer source "${source.name}" has no resolved queue`);
    const messages = new Set<string>();
    for (const [path, text] of files) {
      const stripped = stripComments(text, source.comments);
      const getLine = createLineLocator(stripped);
      for (const match of stripped.matchAll(compiled.regex)) {
        const captured = match.groups?.message?.trim();
        if (captured === undefined || captured === "") continue;
        const message = getSimpleMessageName(captured);
        messages.add(message);
        const queues = map.get(message) ?? new Map();
        if (!queues.has(queue)) {
          const offset = match.indices?.groups?.message?.[0] ?? match.index;
          queues.set(queue, { source: source.name, site: { path, line: getLine(offset) } });
        }
        map.set(message, queues);
      }
    }
    scans.set(source.name, { files: files.length, messages: messages.size });
  }
  return ok({ map, scans });
}

/**
 * Compares which queue consumes each message present at both refs. A queue that consumed a message at the base and
 * does not in the revision leaves the messages already in it without a consumer: `message-consumer-moved` when the
 * revision consumes the message from another queue, `message-consumer-removed` when nothing consumes the queue's
 * share of it any more. A source that matches no file or no consumer in the revision fails the layer.
 */
export async function compareConsumers(options: {
  sources: ConsumerSource[];
  sides: Record<Side, RefTree>;
  /** Simple names of the message types declared at both refs. */
  messages: ReadonlySet<string>;
  /** What the queue sources give at each ref, for the consumer sources with `queueFrom`. */
  queues: Record<Side, ResolvedQueues>;
  readFiles: ReadFiles;
}): Promise<ConsumerOutcome> {
  const { sources, sides } = options;
  const outcome: ConsumerOutcome = { changes: [], notes: [], errors: [] };
  if (sources.length === 0) return outcome;
  const baseQueues = resolveConsumerQueues(sources, options.queues.base, sides.base.ref);
  const revisionQueues = resolveConsumerQueues(sources, options.queues.revision, sides.revision.ref);
  // A consumer whose queue is unknown at a ref could look moved or not; report nothing then.
  if (!baseQueues.ok || !revisionQueues.ok) {
    const errors = [
      ...(baseQueues.ok ? [] : baseQueues.error),
      ...(revisionQueues.ok ? [] : revisionQueues.error),
    ];
    return { ...outcome, errors };
  }
  const base = await scanConsumers(sources, baseQueues.value, sides.base, options.readFiles);
  if (!base.ok) return { ...outcome, errors: [`at ${sides.base.ref}: ${base.error}`] };
  const revision = await scanConsumers(sources, revisionQueues.value, sides.revision, options.readFiles);
  if (!revision.ok) return { ...outcome, errors: [`at ${sides.revision.ref}: ${revision.error}`] };
  for (const source of sources) {
    const atBase = base.value.scans.get(source.name) ?? { files: 0, messages: 0 };
    const atRevision = revision.value.scans.get(source.name) ?? { files: 0, messages: 0 };
    const name = `consumer source "${source.name}"`;
    if (atRevision.files === 0) {
      outcome.errors.push(`${name} matches no file in the revision (${sides.revision.ref})`);
    } else if (atRevision.messages === 0) {
      outcome.errors.push(
        `${name} finds no consumer in ${atRevision.files} file(s) in the revision (${sides.revision.ref})`,
      );
    }
    const queueAtBase = baseQueues.value.get(source.name);
    const queueAtRevision = revisionQueues.value.get(source.name);
    const queue =
      queueAtBase === queueAtRevision
        ? queueAtBase
        : `${queueAtBase} at the base, ${queueAtRevision} in the revision`;
    outcome.notes.push(
      `${name} (${queue}): ${atBase.messages} consumed message(s) at the base, ${atRevision.messages} in the revision`,
    );
  }
  // Without every source, a consumer another source reads could look moved or removed; report nothing then.
  if (outcome.errors.length > 0) return outcome;
  for (const [message, baseQueues] of base.value.map) {
    if (!options.messages.has(message)) continue;
    const revisionQueues: MessageQueues = revision.value.map.get(message) ?? new Map();
    const added = [...revisionQueues.keys()].filter((queue) => !baseQueues.has(queue));
    for (const [queue, { source, site }] of baseQueues) {
      if (revisionQueues.has(queue)) continue;
      const first = added[0] === undefined ? undefined : revisionQueues.get(added[0]);
      outcome.changes.push(
        first === undefined
          ? {
              id: "message-consumer-removed",
              class: "needs-action",
              scope: source,
              subject: message,
              message:
                `consumed from ${queue} at the base, not in the revision (${describeRemaining(revisionQueues)}): ` +
                `messages already in ${queue} get no consumer; drain it before the deploy, or keep its consumer for one release`,
              base: site,
            }
          : {
              id: "message-consumer-moved",
              class: "needs-action",
              scope: first.source,
              subject: message,
              message:
                `consumed from ${queue} at the base and from ${added.join(", ")} in the revision: ` +
                `messages already in ${queue} get no consumer after the deploy, and after a rollback the base build ` +
                `does not consume ${added.join(", ")}; drain ${queue} first, or keep the old endpoint for one release`,
              base: site,
              revision: first.site,
            },
      );
    }
  }
  return outcome;
}
