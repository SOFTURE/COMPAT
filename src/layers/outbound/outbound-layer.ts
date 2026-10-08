import type { RefTree } from "../../git/ref-tree.js";
import type { LayerResult } from "../../model/finding.js";
import { err, ok, type Result } from "../../result.js";
import { DEFAULT_COMPOSE_FILES } from "../config/config.js";
import { readSettingLeaves, type SettingLeaf } from "../config/scan-appsettings.js";
import { defineLayer } from "../layer.js";
import { applyOutboundAccept, classifyOutbound, type TargetDeclaration } from "./classify.js";
import { compileTargetPattern, OUTBOUND_LAYER, outboundConfigSchema, type TargetSource } from "./config.js";
import { type DeployOverride, findLeafKey, getDeployKeyId, readDeployOverrides } from "./deploy-overrides.js";
import { readTargets, type TargetOccurrence } from "./read-targets.js";

type TargetSides = { base: Map<string, TargetDeclaration>; revision: Map<string, TargetDeclaration> };

export const outboundLayer = defineLayer({
  name: OUTBOUND_LAYER,
  description:
    "Outbound calls: external API hosts and paths new in the revision, which production must allow",
  configSchema: outboundConfigSchema,
  async run(context) {
    const notes: string[] = [];
    const errors: string[] = [];
    const base = new Map<string, TargetDeclaration>();
    const revision = new Map<string, TargetDeclaration>();
    // Every source is read even when one fails, so its error and the others' counts reach the report.
    for (const source of context.config.targets) {
      const composeFiles = source.composeFiles ?? context.deployComposeFiles ?? DEFAULT_COMPOSE_FILES;
      const outcome = await readSource(context.base, context.revision, { source, composeFiles });
      if (!outcome.ok) {
        errors.push(`target source "${source.name}": ${outcome.error}`);
        continue;
      }
      addFirst(base, outcome.value.base);
      addFirst(revision, outcome.value.revision);
      notes.push(describeSource(source, outcome.value));
    }
    if (errors.length > 0) {
      // Without every source, a target another source calls could read as added or removed; report nothing then.
      return {
        layer: OUTBOUND_LAYER,
        status: "failed",
        error: errors.join("; "),
        findings: [],
        notes,
      } satisfies LayerResult;
    }
    const accepted = applyOutboundAccept(classifyOutbound(base, revision), context.config.accept ?? []);
    return {
      layer: OUTBOUND_LAYER,
      status: "ran",
      findings: accepted.findings,
      notes: [...notes, ...accepted.notes],
    } satisfies LayerResult;
  },
});

function addFirst(
  target: Map<string, TargetDeclaration>,
  from: ReadonlyMap<string, TargetDeclaration>,
): void {
  for (const [key, declaration] of from) if (!target.has(key)) target.set(key, declaration);
}

/** `target source "x": 1 target(s) at base, 2 at revision`, and how many of them the deploy sets by key. */
function describeSource(source: TargetSource, sides: TargetSides): string {
  const counts = `${sides.base.size} target(s) at base, ${sides.revision.size} at revision`;
  if (source.service === undefined) return `target source "${source.name}": ${counts}`;
  const deployed = [...sides.revision.values()].filter((target) => target.kind === "deployed-key").length;
  return `target source "${source.name}": ${counts}; ${deployed} at revision read from a key compose service "${source.service}" sets`;
}

/** The id a deployed key is compared by; the NUL keeps it apart from every normalized target. */
function getDeployedKeyTargetId(key: string): string {
  return `\0${getDeployKeyId(key)}`;
}

/** The configuration key of an occurrence: its `key` capture, or the appsettings path of the leaf holding it. */
function getOccurrenceKey(
  occurrence: TargetOccurrence,
  leaves: readonly SettingLeaf[] | null,
): string | undefined {
  return (
    occurrence.key ?? (leaves === null ? undefined : findLeafKey(leaves, occurrence.line, occurrence.target))
  );
}

/** The targets one source captures in the files of `tree`, each with its first capture as evidence. */
type SourceSettings = { source: TargetSource; composeFiles: readonly string[] };

async function readTree(
  tree: RefTree,
  { source, composeFiles }: SourceSettings,
  regex: RegExp,
): Promise<Result<{ files: number; targets: Map<string, TargetDeclaration> }>> {
  const files = await tree.listFiles(source.files);
  if (!files.ok) return files;
  let overrides = new Map<string, DeployOverride>();
  if (source.service !== undefined) {
    const read = await readDeployOverrides(tree, {
      service: source.service,
      composeFiles: [...composeFiles],
    });
    if (!read.ok) return read;
    overrides = read.value;
  }
  const targets = new Map<string, TargetDeclaration>();
  for (const path of files.value) {
    const text = await tree.readFile(path);
    if (!text.ok) return err(`cannot read ${path} at ${tree.ref}: ${text.error}`);
    const occurrences = readTargets(text.value ?? "", regex, source.host);
    if (!occurrences.ok) return err(`${path} at ${tree.ref}: ${occurrences.error}`);
    const leaves = source.keyFrom === "appsettings" ? readSettingLeaves(text.value ?? "") : null;
    if (source.keyFrom === "appsettings" && leaves === null)
      return err(`${path} at ${tree.ref} is not valid JSON`);
    for (const occurrence of occurrences.value) {
      const evidence = { side: tree.side, ref: tree.ref, commit: tree.commit, path, line: occurrence.line };
      const key = getOccurrenceKey(occurrence, leaves);
      const deploy = key === undefined ? undefined : overrides.get(getDeployKeyId(key));
      const [id, declaration]: [string, TargetDeclaration] =
        key === undefined || deploy === undefined
          ? [occurrence.target, { kind: "host", source: source.name, evidence }]
          : [
              getDeployedKeyTargetId(key),
              {
                kind: "deployed-key",
                source: source.name,
                evidence,
                key,
                fileTarget: occurrence.target,
                deploy,
              },
            ];
      if (!targets.has(id)) targets.set(id, declaration);
    }
  }
  return ok({ files: files.value.length, targets });
}

async function readSource(
  base: RefTree,
  revision: RefTree,
  settings: SourceSettings,
): Promise<Result<TargetSides>> {
  const { source } = settings;
  const regex = compileTargetPattern(source.pattern, source.flags);
  // The config schema already rejected a pattern that does not compile.
  if (!(regex instanceof RegExp)) throw new Error(`pattern ${source.pattern} ${regex.error}`);
  const [before, after] = await Promise.all([
    readTree(base, settings, regex),
    readTree(revision, settings, regex),
  ]);
  if (!before.ok) return before;
  if (!after.ok) return after;
  if (after.value.files === 0)
    return err(`no file matches ${source.files.join(", ")} at revision ${revision.ref}`);
  // No target at all means a wrong pattern or file: every base target would read as removed.
  if (after.value.targets.size === 0) {
    return err(`pattern captured no target in ${after.value.files} file(s) at revision ${revision.ref}`);
  }
  return ok({ base: before.value.targets, revision: after.value.targets });
}
