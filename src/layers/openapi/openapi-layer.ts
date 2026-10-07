import { mkdir } from "node:fs/promises";
import { join } from "node:path";
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
  type OasdiffSource,
  probeOasdiff,
  runOasdiffChangelog,
} from "./oasdiff.js";
import { isDownloadTurnedOff, PINNED_OASDIFF, provideOasdiff } from "./oasdiff-download.js";
import { resolveSpec } from "./spec-source.js";

type ApiOutcome = { findings: Finding[]; notes: string[] };

export const openapiLayer = defineLayer({
  name: OPENAPI_LAYER,
  description: "HTTP API contract: OpenAPI specs of both refs compared with oasdiff",
  configSchema: openapiConfigSchema,
  async run(context) {
    const located = await findOasdiff(context);
    if (!located.ok)
      return { layer: OPENAPI_LAYER, status: "failed", error: located.error, findings: [], notes: [] };
    if (located.value.status === "missing") {
      return { layer: OPENAPI_LAYER, status: "skipped", reason: located.value.reason };
    }
    const { oasdiff } = located.value;
    const findings: Finding[] = [];
    const notes = [
      `oasdiff ${oasdiff.version || "(no version)"} at ${oasdiff.path} (${OASDIFF_SOURCE_LABELS[oasdiff.source]})`,
    ];
    const errors: string[] = [];
    // Every API is checked even when one fails, so the findings of the others still reach the gate.
    for (const api of context.config.apis) {
      const outcome = await checkApi(context, api, oasdiff);
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

const OASDIFF_SOURCE_LABELS: Record<OasdiffSource, string> = {
  config: "from layers.openapi.oasdiff.path",
  env: `from ${OASDIFF_ENV_VAR}`,
  path: "from PATH",
  cache: "pinned release from the cache",
  download: "pinned release, downloaded and checksum-verified",
};

type FindOutcome = { status: "found"; oasdiff: Oasdiff } | { status: "missing"; reason: string };

/**
 * A configured or PATH oasdiff wins; otherwise the pinned release comes from the cache or is
 * downloaded. A download that fails or does not match its checksum fails the layer, so a
 * check never passes without the API comparison; only an explicit opt-out skips it.
 */
async function findOasdiff(context: LayerContext<OpenapiConfig>): Promise<Result<FindOutcome>> {
  const located = await locateOasdiff({
    configuredPath: context.config.oasdiff?.path,
    env: context.env,
    repoDir: context.repoDir,
  });
  if (!located.ok) return located;
  if (located.value.status === "found") return ok(located.value);
  const isDownloadAllowed = context.config.oasdiff?.download !== false && !isDownloadTurnedOff(context.env);
  if (!isDownloadAllowed) {
    return ok({
      status: "missing",
      reason: `oasdiff not found on PATH and downloading is turned off (set layers.openapi.oasdiff.path or ${OASDIFF_ENV_VAR}, or ${OASDIFF_INSTALL_HINT})`,
    });
  }
  const provided = await provideOasdiff({ env: context.env, log: context.log });
  if (!provided.ok) return provided;
  if (provided.value.status === "unsupported") {
    return ok({
      status: "missing",
      reason: `oasdiff not found on PATH and oasdiff ${PINNED_OASDIFF.version} has no release for ${provided.value.platform} (set layers.openapi.oasdiff.path or ${OASDIFF_ENV_VAR}, or ${OASDIFF_INSTALL_HINT})`,
    });
  }
  const { path, source } = provided.value.oasdiff;
  const probed = await probeOasdiff({ path, source, env: context.env });
  if (!probed.ok) return err(probed.error.message);
  return ok({ status: "found", oasdiff: probed.value });
}

async function checkApi(
  context: LayerContext<OpenapiConfig>,
  api: ApiConfig,
  oasdiff: Oasdiff,
): Promise<Result<ApiOutcome>> {
  const tempDir = join(context.tempDir, api.name);
  await mkdir(tempDir, { recursive: true });
  const specOptions = { source: api.source, tempDir, apiName: api.name, env: context.env };
  const baseSpec = await resolveSpec({ ...specOptions, tree: context.base });
  if (!baseSpec.ok) return { ok: false, error: `base spec: ${baseSpec.error}` };
  const revisionSpec = await resolveSpec({ ...specOptions, tree: context.revision });
  if (!revisionSpec.ok) return { ok: false, error: `revision spec: ${revisionSpec.error}` };

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
