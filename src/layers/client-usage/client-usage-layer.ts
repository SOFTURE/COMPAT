import { openRefTree, type RefTree } from "../../git/ref-tree.js";
import type { Finding, LayerResult } from "../../model/finding.js";
import { resolveRefList } from "../../resolve/ref-list.js";
import type { ResolvedRef } from "../../resolve/resolve-ref.js";
import { err, ok, type Result } from "../../result.js";
import { defineLayer, type FindingRevision, type LayerContext } from "../layer.js";
import { OPENAPI_LAYER } from "../openapi/classify.js";
import { PERSISTED_ENUMS_LAYER } from "../persisted-enums/persisted-enums-layer.js";
import {
  CLIENT_USAGE_LAYER,
  type ClientConfig,
  type ClientUsageConfig,
  clientUsageConfigSchema,
} from "./config.js";
import { type BranchTarget, findEnumBranches } from "./find-enum-branches.js";
import { readIdentifiers, readTypescriptClient } from "./read-typescript-client.js";
import { type ClientRefUsage, formatRefs, refineFindings } from "./refine.js";
import { findExposedFindings, getBranchKey, refineExposedFindings, toBranchTarget } from "./refine-enums.js";

type ClientOutcome = { usages: ClientRefUsage[]; notes: string[] };

export const clientUsageLayer = defineLayer({
  name: CLIENT_USAGE_LAYER,
  description:
    "Live clients: openapi and exposed enum findings re-classified by what live client refs call and branch on",
  configSchema: clientUsageConfigSchema,
  async run(context) {
    const openapi = context.results?.find((result) => result.layer === OPENAPI_LAYER);
    const enums = context.results?.find((result) => result.layer === PERSISTED_ENUMS_LAYER);
    if (openapi === undefined && enums === undefined) {
      return failed(
        `${CLIENT_USAGE_LAYER} refines openapi and exposed persisted-enums findings; enable layers.openapi or layers.persisted-enums`,
      );
    }
    const openapiFindings =
      openapi !== undefined && openapi.status !== "skipped" ? openapi.findings : undefined;
    const enumFindings = enums !== undefined && enums.status !== "skipped" ? enums.findings : [];
    const exposed = findExposedFindings(enumFindings);
    if (openapiFindings === undefined && exposed.length === 0) {
      const reason =
        openapi?.status === "skipped"
          ? `the openapi layer was skipped (${openapi.reason})`
          : "neither openapi findings nor exposed persisted-enums findings to refine";
      return { layer: CLIENT_USAGE_LAYER, status: "skipped", reason };
    }
    const usages: ClientRefUsage[] = [];
    const notes: string[] = [];
    const errors: string[] = [];
    for (const client of context.config.clients) {
      const targets = getBranchTargets(exposed, client.api);
      if (targets.length > 0 && client.sources === undefined) {
        notes.push(
          `client "${client.name}": no "sources", so whether it branches on exposed enums cannot be checked`,
        );
      }
      const outcome = await readClient(context, client, targets);
      if (!outcome.ok) {
        errors.push(`client "${client.name}": ${outcome.error}`);
        continue;
      }
      usages.push(...outcome.value.usages);
      notes.push(...outcome.value.notes);
    }
    // A partial view of the clients could call an operation unused when it is not, so nothing is refined.
    if (errors.length > 0) return failed(errors.join("; "), notes);

    const revisions: FindingRevision[] = [];
    if (openapiFindings === undefined) {
      if (openapi?.status === "skipped") notes.push(`the openapi layer was skipped (${openapi.reason})`);
    } else {
      const apis = new Set([
        ...openapiFindings.map((finding) => finding.scope),
        ...exposed.flatMap(({ finding }) => (finding.exposure ?? []).map((exposure) => exposure.api)),
      ]);
      for (const client of context.config.clients) {
        if (!apis.has(client.api))
          notes.push(`client "${client.name}": the openapi layer has no finding for API "${client.api}"`);
      }
      const summary = refineFindings(openapiFindings, usages);
      revisions.push(...summary.revisions);
      notes.push(
        `reclassified ${summary.toSafe} openapi finding(s) to safe; ${summary.withEvidence} keep their class with client evidence`,
      );
    }
    if (exposed.length > 0) {
      const summary = refineExposedFindings(enumFindings, usages);
      revisions.push(...summary.revisions);
      notes.push(
        `reclassified ${summary.toSafe} exposed enum finding(s) to safe; ${summary.withEvidence} keep their class with client evidence`,
      );
    }
    return { layer: CLIENT_USAGE_LAYER, status: "ran", findings: [], notes, revisions };
  },
});

/** The distinct branch targets of the exposed findings for one API. */
function getBranchTargets(exposed: { finding: Finding }[], api: string): BranchTarget[] {
  const targets = new Map<string, BranchTarget>();
  for (const { finding } of exposed) {
    for (const exposure of finding.exposure ?? []) {
      if (exposure.api !== api) continue;
      const target = toBranchTarget(finding.scope, exposure);
      targets.set(getBranchKey(target), target);
    }
  }
  return [...targets.values()];
}

function failed(error: string, notes: string[] = []): LayerResult {
  return { layer: CLIENT_USAGE_LAYER, status: "failed", error, findings: [], notes };
}

async function readClient(
  context: LayerContext<ClientUsageConfig>,
  client: ClientConfig,
  targets: BranchTarget[],
): Promise<Result<ClientOutcome>> {
  const refs = await resolveRefList(client.refs, {
    repoDir: context.repoDir,
    env: context.env,
    fetch: context.fetch,
  });
  if (!refs.ok) return refs;
  const usages: ClientRefUsage[] = [];
  const notes: string[] = [];
  for (const { ref, commit, resolver } of refs.value) {
    const tree = await openRefTree({
      repoDir: context.repoDir,
      ref: commit ?? ref,
      label: ref,
      side: "base",
      tempRoot: context.tempDir,
    });
    if (!tree.ok) {
      const cause =
        resolver === undefined
          ? tree.error
          : `${resolver} resolved to ${ref} (${commit ?? ref}), which is not in the local clone`;
      return err(`${cause}; fetch the client refs (actions/checkout with fetch-depth: 0)`);
    }
    const usage = await readClientRef(tree.value, client, targets);
    if (!usage.ok) return err(`${ref}: ${usage.error}`);
    usages.push(usage.value.usage);
    notes.push(...usage.value.notes);
  }
  const counts = usages.map((usage) => usage.model.operations.length).join("/");
  notes.unshift(
    `client "${client.name}" (API "${client.api}"): ${formatRefs(usages)}; ${counts} operation(s) read`,
    ...formatResolvers(client.name, refs.value),
  );
  return ok({ usages, notes });
}

/** One note per resolver of a client, naming the refs it resolved to: `client "web": github-deployment:prod → 2.3.5`. */
export function formatResolvers(client: string, refs: readonly ResolvedRef[]): string[] {
  const byResolver = new Map<string, string[]>();
  for (const { ref, resolver } of refs) {
    if (resolver !== undefined) byResolver.set(resolver, [...(byResolver.get(resolver) ?? []), ref]);
  }
  return [...byResolver].map(
    ([resolver, resolved]) => `client "${client}": ${resolver} → ${resolved.join(", ")}`,
  );
}

async function readClientRef(
  tree: RefTree,
  client: ClientConfig,
  targets: BranchTarget[],
): Promise<Result<{ usage: ClientRefUsage; notes: string[] }>> {
  const path = client.generatedClient.path;
  const text = await tree.readFile(path);
  if (!text.ok) return text;
  if (text.value === null) return err(`generated client ${path} does not exist`);
  const model = readTypescriptClient(text.value);
  if (model.operations.length === 0) {
    return err(`no HTTP operation could be read from ${path}; is it a generated TypeScript client?`);
  }
  const notes = model.operations
    .filter((operation) => operation.method === "*")
    .map(
      (operation) =>
        `client "${client.name}" at ${tree.ref}: no HTTP method found for ${operation.path} (${path}:${operation.line}); it counts as called with every method`,
    );
  const usage: ClientRefUsage = {
    client: client.name,
    api: client.api,
    ref: tree.ref,
    commit: tree.commit,
    clientPath: path,
    model,
  };
  if (client.sources !== undefined) {
    const sources = await readSources({ tree, globs: client.sources, clientPath: path, targets });
    if (!sources.ok) return sources;
    usage.sourceIdentifiers = sources.value.identifiers;
    usage.branches = sources.value.branches;
  }
  return ok({ usage, notes });
}

type ReadSourcesOptions = { tree: RefTree; globs: string[]; clientPath: string; targets: BranchTarget[] };

type SourceReads = { identifiers: Set<string>; branches: Map<string, { path: string; line: number }[]> };

/** Identifiers of the client's own sources, and the lines that branch on each exposed enum. */
async function readSources({
  tree,
  globs,
  clientPath,
  targets,
}: ReadSourcesOptions): Promise<Result<SourceReads>> {
  const files = await tree.listFiles(globs);
  if (!files.ok) return files;
  const sources = files.value.filter((file) => file !== clientPath);
  if (sources.length === 0) return err(`sources ${globs.join(", ")} match no file`);
  const identifiers = new Set<string>();
  const branches = new Map(
    targets.map((target) => [getBranchKey(target), [] as { path: string; line: number }[]]),
  );
  for (const file of sources) {
    const text = await tree.readFile(file);
    if (!text.ok) return text;
    const content = text.value ?? "";
    for (const identifier of readIdentifiers(content)) identifiers.add(identifier);
    for (const target of targets) {
      const sites = branches.get(getBranchKey(target)) ?? [];
      for (const line of findEnumBranches(content, target)) sites.push({ path: file, line });
    }
  }
  return ok({ identifiers, branches });
}
