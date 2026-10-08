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
        if (!queues.has(source.queue)) {
          const offset = match.indices?.groups?.message?.[0] ?? match.index;
          queues.set(source.queue, { source: source.name, site: { path, line: getLine(offset) } });
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
  readFiles: ReadFiles;
}): Promise<ConsumerOutcome> {
  const { sources, sides } = options;
  const outcome: ConsumerOutcome = { changes: [], notes: [], errors: [] };
  if (sources.length === 0) return outcome;
  const base = await scanConsumers(sources, sides.base, options.readFiles);
  if (!base.ok) return { ...outcome, errors: [`at ${sides.base.ref}: ${base.error}`] };
  const revision = await scanConsumers(sources, sides.revision, options.readFiles);
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
    outcome.notes.push(
      `${name} (${source.queue}): ${atBase.messages} consumed message(s) at the base, ${atRevision.messages} in the revision`,
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
