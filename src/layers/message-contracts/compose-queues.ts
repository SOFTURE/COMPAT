import { err, ok, type Result } from "../../result.js";
import type { Site } from "./compare-contracts.js";
import { type ComposedQueueSource, getPartSource, getTemplateParts } from "./config.js";

/** More names than this at one ref means the part patterns are too broad. */
export const MAX_COMPOSED_QUEUES = 1000;

/** The names one queue source found at one ref, each with the first place it appears when there is one. */
export type QueueNames = Map<string, Site | undefined>;

/** A queue name with the site of the most specific part read from a source, if any part was, and its part values. */
type Composed = { name: string; site: Site | undefined; parts: string[] };

/** The names a composed source built at one ref, each with its site and the value of every part, in template order. */
export type ComposedQueueNames = Map<string, { site: Site | undefined; parts: string[] }>;

type PartValue = { value: string; site: Site | undefined };

/**
 * Builds the queue names of a composed source at one ref from the names its part sources found there:
 * one name per combination of part values. A part whose source found nothing takes its `default`.
 */
export function composeQueues(
  source: ComposedQueueSource,
  found: ReadonlyMap<string, QueueNames>,
): Result<QueueNames> {
  const composed = composeQueueParts(source, found);
  if (!composed.ok) return composed;
  return ok(new Map([...composed.value].map(([name, { site }]) => [name, site])));
}

/** Like `composeQueues`, and keeps the part values each name was built from. */
export function composeQueueParts(
  source: ComposedQueueSource,
  found: ReadonlyMap<string, QueueNames>,
): Result<ComposedQueueNames> {
  const placeholders = getTemplateParts(source.template);
  const values = new Map<string, PartValue[]>();
  let combinations = 1;
  for (const placeholder of new Set(placeholders)) {
    const part = source.parts[placeholder];
    if (part === undefined) return err(`placeholder {${placeholder}} has no part`);
    const partValues = getPartValues(part, found);
    values.set(placeholder, partValues);
    combinations *= partValues.length;
  }
  if (combinations > MAX_COMPOSED_QUEUES) {
    return err(
      `gives ${combinations} queue names, more than ${MAX_COMPOSED_QUEUES}; narrow the part patterns`,
    );
  }
  const queues: ComposedQueueNames = new Map();
  for (const composed of combine(source.template, placeholders, values)) {
    if (composed.name.trim() === "" || queues.has(composed.name)) continue;
    queues.set(composed.name, { site: composed.site, parts: composed.parts });
  }
  return ok(queues);
}

function getPartValues(
  part: ComposedQueueSource["parts"][string],
  found: ReadonlyMap<string, QueueNames>,
): PartValue[] {
  const fallback = typeof part === "string" ? undefined : part.default;
  const sourceName = getPartSource(part);
  const names = sourceName === undefined ? undefined : found.get(sourceName);
  if (names !== undefined && names.size > 0) {
    return [...names].map(([value, site]) => ({ value, site }));
  }
  return fallback === undefined ? [] : [{ value: fallback, site: undefined }];
}

function* combine(
  template: string,
  placeholders: string[],
  values: Map<string, PartValue[]>,
): Generator<Composed> {
  const order = [...new Set(placeholders)];
  const pick = new Map<string, PartValue>();
  function* walk(depth: number): Generator<Composed> {
    if (depth === order.length) {
      const name = template.replace(
        /\{([A-Za-z0-9_-]+)\}/g,
        (_, part: string) => pick.get(part)?.value ?? "",
      );
      // The last part in template order that came from a source is the most specific one, usually the group.
      const site = [...placeholders].reverse().find((part) => pick.get(part)?.site !== undefined);
      yield {
        name,
        site: site === undefined ? undefined : pick.get(site)?.site,
        parts: order.map((part) => pick.get(part)?.value ?? ""),
      };
      return;
    }
    const placeholder = order[depth] as string;
    for (const value of values.get(placeholder) ?? []) {
      pick.set(placeholder, value);
      yield* walk(depth + 1);
    }
  }
  yield* walk(0);
}
