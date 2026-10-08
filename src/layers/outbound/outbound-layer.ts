import type { RefTree } from "../../git/ref-tree.js";
import type { LayerResult } from "../../model/finding.js";
import { err, ok, type Result } from "../../result.js";
import { defineLayer } from "../layer.js";
import { applyOutboundAccept, classifyOutbound, type TargetDeclaration } from "./classify.js";
import { compileTargetPattern, OUTBOUND_LAYER, outboundConfigSchema, type TargetSource } from "./config.js";
import { readTargets } from "./read-targets.js";

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
      const outcome = await readSource(context.base, context.revision, source);
      if (!outcome.ok) {
        errors.push(`target source "${source.name}": ${outcome.error}`);
        continue;
      }
      addFirst(base, outcome.value.base);
      addFirst(revision, outcome.value.revision);
      notes.push(
        `target source "${source.name}": ${outcome.value.base.size} target(s) at base, ${outcome.value.revision.size} at revision`,
      );
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

/** The targets one source captures in the files of `tree`, each with its first capture as evidence. */
async function readTree(
  tree: RefTree,
  source: TargetSource,
  regex: RegExp,
): Promise<Result<{ files: number; targets: Map<string, TargetDeclaration> }>> {
  const files = await tree.listFiles(source.files);
  if (!files.ok) return files;
  const targets = new Map<string, TargetDeclaration>();
  for (const path of files.value) {
    const text = await tree.readFile(path);
    if (!text.ok) return err(`cannot read ${path} at ${tree.ref}: ${text.error}`);
    for (const { target, line } of readTargets(text.value ?? "", regex, source.host)) {
      if (targets.has(target)) continue;
      targets.set(target, {
        source: source.name,
        evidence: { side: tree.side, ref: tree.ref, commit: tree.commit, path, line },
      });
    }
  }
  return ok({ files: files.value.length, targets });
}

async function readSource(
  base: RefTree,
  revision: RefTree,
  source: TargetSource,
): Promise<Result<TargetSides>> {
  const regex = compileTargetPattern(source.pattern, source.flags);
  // The config schema already rejected a pattern that does not compile.
  if (!(regex instanceof RegExp)) throw new Error(`pattern ${source.pattern} ${regex.error}`);
  const [before, after] = await Promise.all([
    readTree(base, source, regex),
    readTree(revision, source, regex),
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
