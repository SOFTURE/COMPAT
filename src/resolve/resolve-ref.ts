import { z } from "zod";
import { runProcess } from "../process/run-process.js";
import { err, ok, type Result } from "../result.js";
import { type FetchFn, type GitHubContext, getGitHubContext, getRepoJson } from "./github.js";
import { formatRefSpec, type RefSpec } from "./ref-spec.js";
import { selectTags } from "./versions.js";

/** The ref to compare. `commit` is set when the resolver knows the exact commit (a deployment or a run). */
export type ResolvedRef = { ref: string; commit?: string; resolver?: string };

export type ResolveRefOptions = { repoDir: string; env: NodeJS.ProcessEnv; fetch?: FetchFn };

const DEPLOYMENTS_PAGE_SIZE = 100;
const RUNS_PAGE_SIZE = 100;
const RUNS_MAX_PAGES = 10;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const GIT_TIMEOUT_MS = 60_000;

const deploymentsSchema = z.array(z.object({ id: z.number(), sha: z.string(), ref: z.string() }));
const statusesSchema = z.array(z.object({ state: z.string() }));
const workflowRunsSchema = z.object({
  workflow_runs: z.array(
    z.object({ head_sha: z.string(), head_branch: z.string().nullable(), event: z.string() }),
  ),
});

async function resolveDeployment(context: GitHubContext, environment: string): Promise<Result<ResolvedRef>> {
  const deployments = await getRepoJson(
    context,
    `/deployments?environment=${encodeURIComponent(environment)}&per_page=${DEPLOYMENTS_PAGE_SIZE}`,
    deploymentsSchema,
  );
  if (!deployments.ok) return deployments;
  // Newest first. A superseded deployment is marked `inactive`, so the newest `success` is what runs now.
  for (const deployment of deployments.value) {
    const statuses = await getRepoJson(
      context,
      `/deployments/${deployment.id}/statuses?per_page=1`,
      statusesSchema,
    );
    if (!statuses.ok) return statuses;
    if (statuses.value[0]?.state === "success") return ok({ ref: deployment.ref, commit: deployment.sha });
  }
  return err(
    deployments.value.length === 0
      ? `no deployment to environment "${environment}" in ${context.owner}/${context.repo}`
      : `none of the newest ${deployments.value.length} deployments to environment "${environment}" in ${context.owner}/${context.repo} is currently successful`,
  );
}

async function resolveWorkflow(context: GitHubContext, workflow: string): Promise<Result<ResolvedRef>> {
  const runs = await getRepoJson(
    context,
    `/actions/workflows/${encodeURIComponent(workflow)}/runs?status=success&per_page=1`,
    workflowRunsSchema,
  );
  if (!runs.ok) return runs;
  const run = runs.value.workflow_runs[0];
  if (run === undefined)
    return err(`no successful run of workflow "${workflow}" in ${context.owner}/${context.repo}`);
  return ok({ ref: run.head_branch || run.head_sha, commit: run.head_sha });
}

async function resolveLatestTag(repoDir: string, glob: string | undefined): Promise<Result<ResolvedRef>> {
  const result = await runProcess({
    command: "git",
    args: ["tag", "--list", "--sort=-v:refname", ...(glob === undefined ? [] : [glob])],
    cwd: repoDir,
    timeoutMs: GIT_TIMEOUT_MS,
  });
  if (!result.ok || result.value.exitCode !== 0) return err(`git tag --list failed in ${repoDir}`);
  const tag = result.value.stdout.split("\n").find((line) => line.trim() !== "");
  if (tag === undefined) {
    return err(
      glob === undefined
        ? `no tag in ${repoDir}; fetch tags (actions/checkout with fetch-depth: 0)`
        : `no tag matches "${glob}" in ${repoDir}; fetch tags (actions/checkout with fetch-depth: 0)`,
    );
  }
  return ok({ ref: tag.trim() });
}

/** Turns a ref spec into the ref to compare. A resolver that finds nothing is an error, never a guess. */
export async function resolveRefSpec(
  spec: RefSpec,
  options: ResolveRefOptions,
): Promise<Result<ResolvedRef>> {
  if (spec.kind === "literal") return ok({ ref: spec.ref });
  const resolver = formatRefSpec(spec);
  const resolved = await resolveWith(spec, options);
  if (!resolved.ok) return err(`cannot resolve ${resolver}: ${resolved.error}`);
  return ok({ ...resolved.value, resolver });
}

async function resolveWith(
  spec: Exclude<RefSpec, { kind: "literal" }>,
  options: ResolveRefOptions,
): Promise<Result<ResolvedRef>> {
  if (spec.kind === "latest-tag") {
    if (spec.glob === "") return err("a tag glob is required after the colon");
    return resolveLatestTag(options.repoDir, spec.glob);
  }
  const name = spec.kind === "github-deployment" ? spec.environment : spec.workflow;
  if (name === "") {
    return err(
      `${spec.kind === "github-deployment" ? "an environment" : "a workflow file"} is required after the colon`,
    );
  }
  const context = await getGitHubContext(options);
  if (!context.ok) return context;
  return spec.kind === "github-deployment"
    ? resolveDeployment(context.value, spec.environment)
    : resolveWorkflow(context.value, spec.workflow);
}

export type WorkflowRunsOptions = { workflow: string; since?: string };

/**
 * One ref per successful run of a workflow (a build per tag, typically), in version order: the run's
 * `head_branch` (the tag of a tag run) labels its `head_sha`. `since` is a date (`YYYY-MM-DD`, runs
 * created on or after it) or a version (runs whose label holds a version at or above it).
 */
export async function resolveWorkflowRuns(
  { workflow, since }: WorkflowRunsOptions,
  options: ResolveRefOptions,
): Promise<Result<ResolvedRef[]>> {
  if (workflow === "") return err("a workflow file is required");
  const sinceDate = since !== undefined && DATE_PATTERN.test(since) ? since : undefined;
  const sinceVersion = sinceDate === undefined ? since : undefined;
  const context = await getGitHubContext(options);
  if (!context.ok) return context;
  const created = sinceDate === undefined ? "" : `&created=${encodeURIComponent(`>=${sinceDate}`)}`;
  // Newest first, so the first run seen for a label is its newest (a re-run of the same tag).
  const commits = new Map<string, string>();
  for (let page = 1; ; page++) {
    const runs = await getRepoJson(
      context.value,
      `/actions/workflows/${encodeURIComponent(workflow)}/runs?status=success&per_page=${RUNS_PAGE_SIZE}&page=${page}${created}`,
      workflowRunsSchema,
    );
    if (!runs.ok) return runs;
    for (const run of runs.value.workflow_runs) {
      const label = run.head_branch || run.head_sha;
      if (!commits.has(label)) commits.set(label, run.head_sha);
    }
    if (runs.value.workflow_runs.length < RUNS_PAGE_SIZE) break;
    if (page === RUNS_MAX_PAGES) {
      return err(
        `workflow "${workflow}" has more than ${RUNS_PAGE_SIZE * RUNS_MAX_PAGES} successful runs; set "since" to a date (YYYY-MM-DD)`,
      );
    }
  }
  const selected = selectTags([...commits.keys()], sinceVersion);
  if (!selected.ok) return err(`${selected.error} and is not a date (YYYY-MM-DD)`);
  if (selected.value.length === 0) {
    const scope = since === undefined ? "" : ` since ${since}`;
    return err(
      `no successful run of workflow "${workflow}"${scope} in ${context.value.owner}/${context.value.repo}`,
    );
  }
  // Every selected label is a key of `commits`.
  return ok(selected.value.map((ref) => ({ ref, commit: commits.get(ref) as string })));
}
