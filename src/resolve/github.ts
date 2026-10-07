import type { z } from "zod";
import { runProcess } from "../process/run-process.js";
import { err, ok, type Result } from "../result.js";

export type FetchFn = typeof fetch;

export type GitHubContext = {
  apiUrl: string;
  owner: string;
  repo: string;
  token: string;
  fetch: FetchFn;
};

export type GitHubContextOptions = { repoDir: string; env: NodeJS.ProcessEnv; fetch?: FetchFn };

const DEFAULT_API_URL = "https://api.github.com";
const REQUEST_TIMEOUT_MS = 30_000;
const PROCESS_TIMEOUT_MS = 30_000;

/** `owner/repo` from a remote URL: `git@host:owner/repo.git`, `https://host/owner/repo`, `ssh://git@host/owner/repo`. */
export function parseRemoteUrl(url: string): { owner: string; repo: string } | null {
  const match = /[:/]([^/:]+)\/([^/]+?)(?:\.git)?\/?$/.exec(url.trim());
  if (!match) return null;
  return { owner: match[1] as string, repo: match[2] as string };
}

async function findToken(env: NodeJS.ProcessEnv, repoDir: string): Promise<string | null> {
  const fromEnv = env.GH_TOKEN || env.GITHUB_TOKEN;
  if (fromEnv) return fromEnv;
  const result = await runProcess({
    command: "gh",
    args: ["auth", "token"],
    cwd: repoDir,
    env,
    timeoutMs: PROCESS_TIMEOUT_MS,
  });
  if (!result.ok || result.value.exitCode !== 0) return null;
  return result.value.stdout.trim() || null;
}

async function findRepository(
  env: NodeJS.ProcessEnv,
  repoDir: string,
): Promise<Result<{ owner: string; repo: string }>> {
  const fromEnv = env.GITHUB_REPOSITORY;
  if (fromEnv) {
    const [owner, repo, ...rest] = fromEnv.split("/");
    if (owner && repo && rest.length === 0) return ok({ owner, repo });
    return err(`GITHUB_REPOSITORY must be "owner/repo", got "${fromEnv}"`);
  }
  const remote = await runProcess({
    command: "git",
    args: ["remote", "get-url", "origin"],
    cwd: repoDir,
    env,
    timeoutMs: PROCESS_TIMEOUT_MS,
  });
  const parsed = remote.ok && remote.value.exitCode === 0 ? parseRemoteUrl(remote.value.stdout) : null;
  if (parsed === null) {
    return err("cannot tell the GitHub repository: set GITHUB_REPOSITORY=owner/repo or add an origin remote");
  }
  return ok(parsed);
}

/** Token, repository and API URL for the GitHub resolvers. */
export async function getGitHubContext(options: GitHubContextOptions): Promise<Result<GitHubContext>> {
  const repository = await findRepository(options.env, options.repoDir);
  if (!repository.ok) return repository;
  const token = await findToken(options.env, options.repoDir);
  if (token === null) {
    return err("no GitHub token: set GH_TOKEN or GITHUB_TOKEN, or sign in with the gh CLI");
  }
  return ok({
    apiUrl: (options.env.GITHUB_API_URL || DEFAULT_API_URL).replace(/\/+$/, ""),
    ...repository.value,
    token,
    fetch: options.fetch ?? fetch,
  });
}

/** GETs `path` under `/repos/{owner}/{repo}` and narrows the JSON body with `schema`. */
export async function getRepoJson<T>(
  context: GitHubContext,
  path: string,
  schema: z.ZodType<T>,
): Promise<Result<T>> {
  const url = `${context.apiUrl}/repos/${encodeURIComponent(context.owner)}/${encodeURIComponent(context.repo)}${path}`;
  const label = `GET ${url}`;
  let response: Response;
  try {
    response = await context.fetch(url, {
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${context.token}`,
        "X-GitHub-Api-Version": "2022-11-28",
      },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    return err(`${label} failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!response.ok) {
    const hint =
      response.status === 401 || response.status === 403 || response.status === 404
        ? " (check that the token can read the repository, its deployments and its Actions runs)"
        : "";
    return err(`${label} returned HTTP ${response.status}${hint}`);
  }
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return err(`${label} did not return JSON`);
  }
  const parsed = schema.safeParse(body);
  if (!parsed.success) return err(`${label} returned an unexpected body: ${parsed.error.issues[0]?.message}`);
  return ok(parsed.data);
}
