import type { FetchFn } from "../../src/resolve/github.js";

export const GITHUB_ENV: NodeJS.ProcessEnv = {
  PATH: process.env.PATH,
  GH_TOKEN: "test-token",
  GITHUB_REPOSITORY: "acme/shop",
  GITHUB_API_URL: "https://github.test/api/v3",
};

/**
 * A `fetch` that answers from `routes`, keyed by the path and query under `/repos/acme/shop`.
 * A number is returned as that HTTP status; an unknown path is a 404. `calls` records each path.
 */
export function createFakeGitHub(routes: Record<string, unknown>) {
  const calls: string[] = [];
  const headers: Record<string, string>[] = [];
  const prefix = "https://github.test/api/v3/repos/acme/shop";
  const fakeFetch: FetchFn = async (input, init) => {
    const url = String(input);
    const path = url.startsWith(prefix) ? url.slice(prefix.length) : url;
    calls.push(path);
    headers.push((init?.headers ?? {}) as Record<string, string>);
    const body = routes[path];
    if (body === undefined) return new Response("{}", { status: 404 });
    if (typeof body === "number") return new Response("{}", { status: body });
    return new Response(JSON.stringify(body), { status: 200 });
  };
  return { fetch: fakeFetch, calls, headers };
}
