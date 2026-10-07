import type { RefTree } from "../../git/ref-tree.js";
import type { Finding, LayerResult } from "../../model/finding.js";
import { err, ok, type Result } from "../../result.js";
import { defineLayer, type LayerContext } from "../layer.js";
import { applySeedAccept, classifySeedSource, SEED_LAYER, type SeedFile } from "./classify.js";
import { type SeedConfig, type SeedSource, seedConfigSchema } from "./config.js";
import { readSeedStatements, type SeedStatement } from "./seed-statements.js";

type SourceOutcome = { findings: Finding[]; notes: string[] };

export const seedLayer = defineLayer({
  name: SEED_LAYER,
  description:
    "Seed scripts that run on every deploy: what the revision's version does to rows that already exist",
  configSchema: seedConfigSchema,
  async run(context) {
    const findings: Finding[] = [];
    const notes: string[] = [];
    const errors: string[] = [];
    // Every source is checked even when one fails, so the findings of the others still reach the gate.
    for (const source of context.config.sources) {
      const outcome = await checkSource(context, source);
      if (!outcome.ok) {
        errors.push(`source "${source.name}": ${outcome.error}`);
        continue;
      }
      findings.push(...outcome.value.findings);
      notes.push(...outcome.value.notes);
    }
    if (errors.length > 0) {
      return {
        layer: SEED_LAYER,
        status: "failed",
        error: errors.join("; "),
        findings,
        notes,
      } satisfies LayerResult;
    }
    return { layer: SEED_LAYER, status: "ran", findings, notes } satisfies LayerResult;
  },
});

async function readStatements(
  tree: RefTree,
  path: string,
  source: SeedSource,
): Promise<Result<SeedStatement[] | null>> {
  const content = await tree.readFile(path);
  if (!content.ok) return err(`cannot read ${path} at ${tree.side} ${tree.ref}: ${content.error}`);
  return ok(content.value === null ? null : readSeedStatements(content.value, source.dialect));
}

async function checkSource(
  context: LayerContext<SeedConfig>,
  source: SeedSource,
): Promise<Result<SourceOutcome>> {
  const { base, revision } = context;
  const [baseFiles, revisionFiles] = await Promise.all([
    base.listFiles(source.files),
    revision.listFiles(source.files),
  ]);
  if (!baseFiles.ok) return baseFiles;
  if (!revisionFiles.ok) return revisionFiles;
  if (revisionFiles.value.length === 0) {
    return err(`no seed file matches ${source.files.join(", ")} at revision ${revision.ref}`);
  }
  const files: SeedFile[] = [];
  let statementCount = 0;
  let rowCount = 0;
  const paths = [...new Set([...revisionFiles.value, ...baseFiles.value])].sort();
  for (const path of paths) {
    const [before, after] = await Promise.all([
      readStatements(base, path, source),
      readStatements(revision, path, source),
    ]);
    if (!before.ok) return before;
    if (!after.ok) return after;
    for (const statement of after.value ?? []) {
      statementCount += 1;
      if (statement.kind === "rows") rowCount += statement.rows.length;
    }
    files.push({ path, base: before.value, revision: after.value });
  }
  const classified = classifySeedSource({
    sourceName: source.name,
    files,
    baseTree: base,
    revisionTree: revision,
  });
  const { findings, usage } = applySeedAccept(classified, source.accept ?? []);
  const notes = [
    `source "${source.name}": ${revisionFiles.value.length} file(s), ${statementCount} write statement(s), ${rowCount} row(s) read at the revision`,
    ...usage.map(({ entry, count }) => {
      const target = `${entry.id}${entry.object ? ` on ${entry.object}` : ""}`;
      return count === 0
        ? `source "${source.name}": accept entry ${target} matched nothing; remove it if the change is gone`
        : `source "${source.name}": accept entry ${target} accepted ${count} finding(s)`;
    }),
  ];
  return ok({ findings, notes });
}
