import { openRefTree, type RefTree } from "../../git/ref-tree.js";
import type { LayerResult } from "../../model/finding.js";
import { err, ok, type Result } from "../../result.js";
import { defineLayer, type LayerContext } from "../layer.js";
import { OPENAPI_LAYER } from "../openapi/classify.js";
import { resolveClientRefs } from "./client-refs.js";
import {
  CLIENT_USAGE_LAYER,
  type ClientConfig,
  type ClientUsageConfig,
  clientUsageConfigSchema,
} from "./config.js";
import { readIdentifiers, readTypescriptClient } from "./read-typescript-client.js";
import { type ClientRefUsage, formatRefs, refineFindings } from "./refine.js";

type ClientOutcome = { usages: ClientRefUsage[]; notes: string[] };

export const clientUsageLayer = defineLayer({
  name: CLIENT_USAGE_LAYER,
  description:
    "Live clients: openapi findings re-classified by what the generated clients of live client refs call",
  configSchema: clientUsageConfigSchema,
  async run(context) {
    const openapi = context.results?.find((result) => result.layer === OPENAPI_LAYER);
    if (openapi === undefined) {
      return failed(`${CLIENT_USAGE_LAYER} refines openapi findings; enable layers.openapi`);
    }
    if (openapi.status === "skipped") {
      return {
        layer: CLIENT_USAGE_LAYER,
        status: "skipped",
        reason: `the openapi layer was skipped (${openapi.reason})`,
      };
    }
    const usages: ClientRefUsage[] = [];
    const notes: string[] = [];
    const errors: string[] = [];
    for (const client of context.config.clients) {
      const outcome = await readClient(context, client);
      if (!outcome.ok) {
        errors.push(`client "${client.name}": ${outcome.error}`);
        continue;
      }
      usages.push(...outcome.value.usages);
      notes.push(...outcome.value.notes);
    }
    // A partial view of the clients could call an operation unused when it is not, so nothing is refined.
    if (errors.length > 0) return failed(errors.join("; "), notes);

    const apis = new Set(openapi.findings.map((finding) => finding.scope));
    for (const client of context.config.clients) {
      if (!apis.has(client.api))
        notes.push(`client "${client.name}": the openapi layer has no finding for API "${client.api}"`);
    }
    const summary = refineFindings(openapi.findings, usages);
    notes.push(
      `reclassified ${summary.toSafe} openapi finding(s) to safe; ${summary.withEvidence} keep their class with client evidence`,
    );
    return { layer: CLIENT_USAGE_LAYER, status: "ran", findings: [], notes, revisions: summary.revisions };
  },
});

function failed(error: string, notes: string[] = []): LayerResult {
  return { layer: CLIENT_USAGE_LAYER, status: "failed", error, findings: [], notes };
}

async function readClient(
  context: LayerContext<ClientUsageConfig>,
  client: ClientConfig,
): Promise<Result<ClientOutcome>> {
  const refs = await resolveClientRefs(client.refs, { repoDir: context.repoDir, env: context.env });
  if (!refs.ok) return refs;
  const usages: ClientRefUsage[] = [];
  const notes: string[] = [];
  for (const ref of refs.value) {
    const tree = await openRefTree({
      repoDir: context.repoDir,
      ref,
      side: "base",
      tempRoot: context.tempDir,
    });
    if (!tree.ok) return err(`${tree.error}; fetch the client refs (actions/checkout with fetch-depth: 0)`);
    const usage = await readClientRef(tree.value, client);
    if (!usage.ok) return err(`${ref}: ${usage.error}`);
    usages.push(usage.value.usage);
    notes.push(...usage.value.notes);
  }
  const counts = usages.map((usage) => usage.model.operations.length).join("/");
  notes.unshift(
    `client "${client.name}" (API "${client.api}"): ${formatRefs(usages)}; ${counts} operation(s) read`,
  );
  return ok({ usages, notes });
}

async function readClientRef(
  tree: RefTree,
  client: ClientConfig,
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
    const identifiers = await readSourceIdentifiers(tree, client.sources, path);
    if (!identifiers.ok) return identifiers;
    usage.sourceIdentifiers = identifiers.value;
  }
  return ok({ usage, notes });
}

async function readSourceIdentifiers(
  tree: RefTree,
  globs: string[],
  clientPath: string,
): Promise<Result<Set<string>>> {
  const files = await tree.listFiles(globs);
  if (!files.ok) return files;
  const sources = files.value.filter((file) => file !== clientPath);
  if (sources.length === 0) return err(`sources ${globs.join(", ")} match no file`);
  const identifiers = new Set<string>();
  for (const file of sources) {
    const text = await tree.readFile(file);
    if (!text.ok) return text;
    for (const identifier of readIdentifiers(text.value ?? "")) identifiers.add(identifier);
  }
  return ok(identifiers);
}
