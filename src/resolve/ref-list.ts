import { z } from "zod";
import { getTailLines, runProcess } from "../process/run-process.js";
import { err, ok, type Result } from "../result.js";
import { otaUpdatesSchema, readOtaUpdates } from "./ota-updates.js";
import { parseRefSpec } from "./ref-spec.js";
import {
  type ResolvedRef,
  type ResolveRefOptions,
  resolveRefSpec,
  resolveWorkflowRuns,
} from "./resolve-ref.js";
import { selectTags } from "./versions.js";

const GIT_TIMEOUT_MS = 60_000;

const gitRef = z
  .string()
  .min(1)
  .refine((ref) => !ref.startsWith("-"), "must not start with '-'");

/** `true`: an entry that resolves to nothing adds a note instead of failing the layer. */
const optional = z.boolean().optional();

const refEntrySchema = z.strictObject({
  /** A ref or resolver, as a plain string entry. */
  ref: gitRef,
  optional,
});

const tagsSelectorSchema = z.strictObject({
  /** `git tag --list` pattern, for example `2.*`. */
  tags: gitRef,
  /** Lowest version to keep; tags without a version are dropped when it is set. */
  since: z.string().min(1).optional(),
  optional,
});

const workflowRunsSelectorSchema = z.strictObject({
  /** Workflow file whose successful runs are the live builds, for example `eas-prod.yml`. */
  workflowRuns: z.string().min(1),
  /** A date (`YYYY-MM-DD`) or the lowest version to keep. */
  since: z.string().min(1).optional(),
  optional,
});

const easUpdatesSelectorSchema = z.strictObject({
  /** A command printing the live over-the-air updates, one `commit<TAB>label[<TAB>dirty]` line each. */
  easUpdates: otaUpdatesSchema,
  optional,
});

const refSelectorSchema = z.union([
  refEntrySchema,
  tagsSelectorSchema,
  workflowRunsSelectorSchema,
  easUpdatesSelectorSchema,
]);

/** A ref or resolver (`github-deployment:prod`, `latest-tag:2.*`, …), or a selector of several refs. */
const refListEntrySchema = z.union([gitRef, refSelectorSchema]);

/** Live builds of a client: a list of entries, or one selector on its own. */
export const refListSchema = z.union([z.array(refListEntrySchema).min(1), refSelectorSchema]);

export type RefList = z.infer<typeof refListSchema>;

export type RefListEntry = z.infer<typeof refListEntrySchema>;

/** The resolver label of an entry, as notes show it, or `undefined` for a literal ref. */
export function formatRefListEntry(entry: RefListEntry): string | undefined {
  if (typeof entry === "string") return parseRefSpec(entry).kind === "literal" ? undefined : entry;
  if ("ref" in entry) return formatRefListEntry(entry.ref);
  if ("easUpdates" in entry) return "easUpdates";
  const since = entry.since === undefined ? "" : ` since ${entry.since}`;
  return "tags" in entry ? `tags:${entry.tags}${since}` : `workflowRuns:${entry.workflowRuns}${since}`;
}

/** The refs of a list, and notes on what an entry left out or only approximates. */
export type ResolvedRefList = { refs: ResolvedRef[]; notes: string[] };

/**
 * Resolves every entry to refs; a ref seen twice (same commit, or same name without one) is kept once,
 * at its first place. Each ref of a non-literal entry carries that entry's label as `resolver`. An
 * `optional` entry that fails adds a note instead; a list that resolves to no ref at all fails.
 */
export async function resolveRefList(
  list: RefList,
  options: ResolveRefOptions,
): Promise<Result<ResolvedRefList>> {
  const entries = Array.isArray(list) ? list : [list];
  const resolved: ResolvedRef[] = [];
  const notes: string[] = [];
  const seen = new Set<string>();
  for (const entry of entries) {
    const refs = await resolveEntry(entry, options);
    if (!refs.ok) {
      if (typeof entry === "string" || entry.optional !== true) return refs;
      notes.push(`optional entry skipped: ${refs.error}`);
      continue;
    }
    notes.push(...refs.value.notes);
    const resolver = formatRefListEntry(entry);
    for (const ref of refs.value.refs) {
      const key = ref.commit ?? ref.ref;
      if (seen.has(key)) continue;
      seen.add(key);
      resolved.push(resolver === undefined ? ref : { ...ref, resolver });
    }
  }
  if (resolved.length === 0) return err(`no entry of refs resolved to a ref (${notes.join("; ")})`);
  return ok({ refs: resolved, notes });
}

async function resolveEntry(
  entry: RefListEntry,
  options: ResolveRefOptions,
): Promise<Result<ResolvedRefList>> {
  if (typeof entry === "string" || "ref" in entry) {
    const spec = typeof entry === "string" ? entry : entry.ref;
    const ref = await resolveRefSpec(parseRefSpec(spec), options);
    return ref.ok ? ok({ refs: [ref.value], notes: [] }) : ref;
  }
  if ("easUpdates" in entry) {
    const updates = await readOtaUpdates({
      settings: entry.easUpdates,
      cwd: options.repoDir,
      env: options.env,
    });
    return updates.ok ? updates : err(`cannot resolve easUpdates: ${updates.error}`);
  }
  if ("tags" in entry) {
    const tags = await resolveTags(entry.tags, entry.since, options);
    return tags.ok ? ok({ refs: tags.value, notes: [] }) : tags;
  }
  const runs = await resolveWorkflowRuns({ workflow: entry.workflowRuns, since: entry.since }, options);
  return runs.ok
    ? ok({ refs: runs.value, notes: [] })
    : err(`cannot resolve ${formatRefListEntry(entry)}: ${runs.error}`);
}

/** Local tags matching the `git tag --list` pattern, in version order, at or above `since`. */
async function resolveTags(
  pattern: string,
  since: string | undefined,
  options: ResolveRefOptions,
): Promise<Result<ResolvedRef[]>> {
  const listed = await runProcess({
    command: "git",
    args: ["tag", "--list", pattern],
    cwd: options.repoDir,
    env: options.env,
    timeoutMs: GIT_TIMEOUT_MS,
  });
  if (!listed.ok) return err(`git tag --list ${pattern} could not run (${listed.error.kind})`);
  if (listed.value.exitCode !== 0) {
    return err(`git tag --list ${pattern} failed: ${getTailLines(listed.value.stderr, 5)}`);
  }
  const tags = listed.value.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "");
  const selected = selectTags(tags, since);
  if (!selected.ok) return selected;
  if (selected.value.length === 0) {
    const scope = since === undefined ? "" : ` since ${since}`;
    return err(`no local tag matches ${pattern}${scope}; fetch tags (actions/checkout with fetch-depth: 0)`);
  }
  return ok(selected.value.map((ref) => ({ ref })));
}

/** One note per resolver of a client, naming the refs it resolved to: `client "web": github-deployment:prod → 2.3.5`. */
export function formatResolvers(client: string, { refs, notes }: ResolvedRefList): string[] {
  const byResolver = new Map<string, string[]>();
  for (const { ref, resolver } of refs) {
    if (resolver !== undefined) byResolver.set(resolver, [...(byResolver.get(resolver) ?? []), ref]);
  }
  return [
    ...[...byResolver].map(
      ([resolver, resolved]) => `client "${client}": ${resolver} → ${resolved.join(", ")}`,
    ),
    ...notes.map((note) => `client "${client}": ${note}`),
  ];
}
