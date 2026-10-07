import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { RefTree } from "../../git/ref-tree.js";
import type { Finding, LayerResult } from "../../model/finding.js";
import { err, ok, type Result } from "../../result.js";
import { defineLayer, type LayerContext } from "../layer.js";
import { applyAccept, classifyChanges, OPENAPI_LAYER } from "./classify.js";
import { type ApiConfig, type OpenapiConfig, openapiConfigSchema } from "./config.js";
import {
  locateOasdiff,
  OASDIFF_ENV_VAR,
  OASDIFF_INSTALL_HINT,
  type Oasdiff,
  runOasdiffChangelog,
} from "./oasdiff.js";
import { type ResolvedSpec, resolveSpec } from "./spec-source.js";
import { runTreeCommand } from "./tree-command.js";

type ApiOutcome = { findings: Finding[]; notes: string[] };

/** The spec of every API at one side, by API name; one API failing does not stop the others. */
type SideSpecs = Map<string, Result<ResolvedSpec>>;

export const openapiLayer = defineLayer({
  name: OPENAPI_LAYER,
  description: "HTTP API contract: OpenAPI specs of both refs compared with oasdiff",
  configSchema: openapiConfigSchema,
  async run(context) {
    const located = await locateOasdiff({
      configuredPath: context.config.oasdiff?.path,
      env: context.env,
      repoDir: context.repoDir,
    });
    if (!located.ok)
      return { layer: OPENAPI_LAYER, status: "failed", error: located.error, findings: [], notes: [] };
    if (located.value.status === "not-found") {
      return {
        layer: OPENAPI_LAYER,
        status: "skipped",
        reason: `oasdiff not found on PATH (set layers.openapi.oasdiff.path or ${OASDIFF_ENV_VAR}, or ${OASDIFF_INSTALL_HINT})`,
      };
    }
    const { oasdiff } = located.value;
    const findings: Finding[] = [];
    const notes = [`oasdiff ${oasdiff.version || "(no version)"} at ${oasdiff.path}`];
    const sides = await prepareSides(context);
    if (!sides.ok) {
      return {
        layer: OPENAPI_LAYER,
        status: "failed",
        error: sides.error,
        findings,
        notes,
      } satisfies LayerResult;
    }
    const [baseSpecs, revisionSpecs] = sides.value;
    const errors: string[] = [];
    // Every API is checked even when one fails, so the findings of the others still reach the gate.
    for (const api of context.config.apis) {
      const outcome = await checkApi({
        context,
        api,
        oasdiff,
        baseSpec: baseSpecs.get(api.name),
        revisionSpec: revisionSpecs.get(api.name),
      });
      if (!outcome.ok) {
        errors.push(`API "${api.name}": ${outcome.error}`);
        continue;
      }
      findings.push(...outcome.value.findings);
      notes.push(...outcome.value.notes);
    }
    if (errors.length > 0) {
      return {
        layer: OPENAPI_LAYER,
        status: "failed",
        error: errors.join("; "),
        findings,
        notes,
      } satisfies LayerResult;
    }
    return { layer: OPENAPI_LAYER, status: "ran", findings, notes } satisfies LayerResult;
  },
});

/**
 * Prepares both sides: base and revision live in separate trees, so they run in parallel unless
 * `concurrency` is 1. Both sides finish before any failure is reported, so a setup that fails on
 * both sides names both.
 */
async function prepareSides(context: LayerContext<OpenapiConfig>): Promise<Result<[SideSpecs, SideSpecs]>> {
  const trees = [context.base, context.revision] as const;
  let prepared: Result<SideSpecs>[];
  if (context.config.concurrency === 1) {
    prepared = [];
    for (const tree of trees) prepared.push(await prepareSide(context, tree));
  } else {
    prepared = await Promise.all(trees.map((tree) => prepareSide(context, tree)));
  }
  const [base, revision] = prepared as [Result<SideSpecs>, Result<SideSpecs>];
  const errors = [base, revision].flatMap((side) => (side.ok ? [] : [side.error]));
  if (!base.ok || !revision.ok) return err(errors.join("; "));
  return ok([base.value, revision.value]);
}

/** Runs the setup command of one side, then resolves the spec of every API at that side, in order. */
async function prepareSide(context: LayerContext<OpenapiConfig>, tree: RefTree): Promise<Result<SideSpecs>> {
  const { setup } = context.config;
  if (setup) {
    const root = await tree.materialize();
    if (!root.ok) return root;
    context.log(`openapi: running setup at ${tree.side} (${tree.ref})`);
    const ran = await runTreeCommand({
      run: setup.run,
      tree,
      root: root.value,
      timeoutSeconds: setup.timeoutSeconds,
      env: context.env,
      label: "setup command",
    });
    if (!ran.ok) return ran;
  }
  const specs: SideSpecs = new Map();
  for (const api of context.config.apis) {
    const tempDir = join(context.tempDir, api.name);
    await mkdir(tempDir, { recursive: true });
    specs.set(
      api.name,
      await resolveSpec({ source: api.source, tree, tempDir, apiName: api.name, env: context.env }),
    );
  }
  return ok(specs);
}

type CheckApiOptions = {
  context: LayerContext<OpenapiConfig>;
  api: ApiConfig;
  oasdiff: Oasdiff;
  baseSpec: Result<ResolvedSpec> | undefined;
  revisionSpec: Result<ResolvedSpec> | undefined;
};

async function checkApi(options: CheckApiOptions): Promise<Result<ApiOutcome>> {
  const { context, api, oasdiff, baseSpec, revisionSpec } = options;
  if (!baseSpec || !revisionSpec) return err("spec was not resolved");
  if (!baseSpec.ok) return err(`base spec: ${baseSpec.error}`);
  if (!revisionSpec.ok) return err(`revision spec: ${revisionSpec.error}`);

  const base = baseSpec.value;
  const revision = revisionSpec.value;
  if (base.status === "absent" && revision.status === "absent") {
    return { ok: false, error: `spec ${revision.displayPath} exists at neither ref` };
  }
  if (base.status === "absent" || revision.status === "absent") {
    const isAdded = base.status === "absent";
    const tree = isAdded ? context.revision : context.base;
    const finding: Finding = {
      layer: OPENAPI_LAYER,
      scope: api.name,
      id: isAdded ? "api-added" : "api-removed",
      subject: isAdded ? revision.displayPath : base.displayPath,
      class: isAdded ? "safe" : "breaking",
      message: isAdded
        ? "the API spec is new in the revision; old clients cannot depend on it"
        : "the API spec exists at the base but not in the revision; every old client of this API breaks",
      evidence: [
        {
          side: tree.side,
          ref: tree.ref,
          commit: tree.commit,
          path: isAdded ? revision.displayPath : base.displayPath,
        },
      ],
    };
    return applyAcceptToOutcome(api, [{ finding, operation: undefined }]);
  }

  const changes = await runOasdiffChangelog({
    oasdiff,
    baseFile: base.file,
    revisionFile: revision.file,
    args: context.config.oasdiff?.args,
    env: context.env,
  });
  if (!changes.ok) return changes;
  const classified = classifyChanges({
    apiName: api.name,
    changes: changes.value,
    base: context.base,
    revision: context.revision,
    baseSpec: base,
    revisionSpec: revision,
  });
  return applyAcceptToOutcome(api, classified);
}

function applyAcceptToOutcome(
  api: ApiConfig,
  classified: Parameters<typeof applyAccept>[0],
): Result<ApiOutcome> {
  const { findings, usage } = applyAccept(classified, api.accept ?? []);
  const notes = usage.map(({ entry, count }) => {
    const target = `${entry.id}${entry.operation ? ` on ${entry.operation}` : ""}`;
    return count === 0
      ? `API "${api.name}": accept entry ${target} matched nothing; remove it if the change is gone`
      : `API "${api.name}": accept entry ${target} accepted ${count} finding(s)`;
  });
  return { ok: true, value: { findings, notes } };
}
