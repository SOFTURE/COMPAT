import { z } from "zod";
import { ok, type Result } from "../result.js";
import { type FetchFn, type GitHubContext, getGitHubContext, getRepoJson } from "./github.js";
import { GITHUB_DEPLOYMENT_PREFIX, LATEST_TAG } from "./ref-spec.js";

/** The `check` defaults `init` writes, and a line that says how they were chosen. */
export type CheckGuess = { base: string; revision: string; reason: string };

export type GuessCheckDefaultsOptions = { repoDir: string; env: NodeJS.ProcessEnv; fetch?: FetchFn };

const DEPLOYMENTS_PAGE_SIZE = 100;
const PRODUCTION_NAME = /prod/i;

const deploymentsSchema = z.array(z.object({ id: z.number(), environment: z.string() }));
const statusesSchema = z.array(z.object({ state: z.string() }));

/**
 * Environments whose newest deployment in the page is currently successful, most recent first, at most two.
 * Deployments come newest first, so one status call per environment is enough.
 */
async function findDeployedEnvironments(context: GitHubContext): Promise<Result<string[]>> {
  const deployments = await getRepoJson(
    context,
    `/deployments?per_page=${DEPLOYMENTS_PAGE_SIZE}`,
    deploymentsSchema,
  );
  if (!deployments.ok) return deployments;
  const seen = new Set<string>();
  const deployed: string[] = [];
  for (const deployment of deployments.value) {
    if (seen.has(deployment.environment)) continue;
    const statuses = await getRepoJson(
      context,
      `/deployments/${deployment.id}/statuses?per_page=1`,
      statusesSchema,
    );
    if (!statuses.ok) return statuses;
    if (statuses.value[0]?.state !== "success") continue;
    seen.add(deployment.environment);
    deployed.push(deployment.environment);
    if (deployed.length === 2) break;
  }
  return ok(deployed);
}

/** Production is the environment named like it; otherwise the one deployed less recently. */
function pickBase(recentFirst: [string, string]): { base: string; revision: string } {
  const [newer, older] = recentFirst;
  if (PRODUCTION_NAME.test(newer) && !PRODUCTION_NAME.test(older)) return { base: newer, revision: older };
  return { base: older, revision: newer };
}

async function guessFromDeployments(options: GuessCheckDefaultsOptions): Promise<Result<CheckGuess | null>> {
  const context = await getGitHubContext(options);
  if (!context.ok) return context;
  const environments = await findDeployedEnvironments(context.value);
  if (!environments.ok) return environments;
  const [first, second] = environments.value;
  if (first === undefined) return ok(null);
  if (second === undefined) {
    return ok({
      base: `${GITHUB_DEPLOYMENT_PREFIX}${first}`,
      revision: "HEAD",
      reason: `"${first}" is the only GitHub environment with a successful deployment`,
    });
  }
  const { base, revision } = pickBase([first, second]);
  return ok({
    base: `${GITHUB_DEPLOYMENT_PREFIX}${base}`,
    revision: `${GITHUB_DEPLOYMENT_PREFIX}${revision}`,
    reason: `"${first}" and "${second}" have the most recent successful GitHub deployments; "${base}" is taken as production`,
  });
}

/**
 * The refs `check` should compare by default: GitHub environments with successful deployments, or the newest tag
 * against `HEAD`. Never fails: when GitHub cannot be read, the fallback says why.
 */
export async function guessCheckDefaults(options: GuessCheckDefaultsOptions): Promise<CheckGuess> {
  const guess = await guessFromDeployments(options);
  if (guess.ok && guess.value !== null) return guess.value;
  const why = guess.ok
    ? "no GitHub environment has a successful deployment"
    : `GitHub not read: ${guess.error}`;
  return { base: LATEST_TAG, revision: "HEAD", reason: `${why}; comparing the newest tag with HEAD` };
}
