import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parseRemoteUrl } from "../../src/resolve/github.js";
import { parseRefSpec } from "../../src/resolve/ref-spec.js";
import { resolveRefSpec } from "../../src/resolve/resolve-ref.js";
import { createFakeGitHub, GITHUB_ENV } from "../helpers/fake-github.js";
import { createRepo, type TestRepo } from "../helpers/git-repo.js";

let repo: TestRepo;

beforeAll(() => {
  repo = createRepo([
    { files: { "a.txt": "1" }, tag: "v1.2.9" },
    { files: { "a.txt": "2" }, tag: "v1.2.10" },
    { files: { "a.txt": "3" }, tag: "v2.0.0" },
    { files: { "a.txt": "4" }, tag: "dev-5" },
  ]);
});
afterAll(() => repo.cleanup());

const resolve = (value: string, routes: Record<string, unknown>, env: NodeJS.ProcessEnv = GITHUB_ENV) => {
  const github = createFakeGitHub(routes);
  return {
    github,
    result: resolveRefSpec(parseRefSpec(value), { repoDir: repo.dir, env, fetch: github.fetch }),
  };
};

const DEPLOYMENTS = "/deployments?environment=prod&per_page=100";

describe("github-deployment", () => {
  it("picks the newest deployment whose newest status is success, skipping failure and inactive", async () => {
    const { result, github } = resolve("github-deployment:prod", {
      [DEPLOYMENTS]: [
        { id: 4, sha: "d".repeat(40), ref: "2.3.0" },
        { id: 3, sha: "c".repeat(40), ref: "2.2.5" },
        { id: 2, sha: "b".repeat(40), ref: "2.2.4" },
        { id: 1, sha: "a".repeat(40), ref: "2.2.3" },
      ],
      "/deployments/4/statuses?per_page=1": [{ state: "failure" }],
      "/deployments/3/statuses?per_page=1": [{ state: "inactive" }],
      "/deployments/2/statuses?per_page=1": [{ state: "success" }],
      "/deployments/1/statuses?per_page=1": [{ state: "success" }],
    });
    expect(await result).toEqual({
      ok: true,
      value: { ref: "2.2.4", commit: "b".repeat(40), resolver: "github-deployment:prod" },
    });
    expect(github.calls).toEqual([
      DEPLOYMENTS,
      "/deployments/4/statuses?per_page=1",
      "/deployments/3/statuses?per_page=1",
      "/deployments/2/statuses?per_page=1",
    ]);
    expect(github.headers[0]?.Authorization).toBe("Bearer test-token");
  });

  it("skips a deployment with no status yet", async () => {
    const { result } = resolve("github-deployment:prod", {
      [DEPLOYMENTS]: [
        { id: 2, sha: "b".repeat(40), ref: "2.2.5" },
        { id: 1, sha: "a".repeat(40), ref: "2.2.4" },
      ],
      "/deployments/2/statuses?per_page=1": [],
      "/deployments/1/statuses?per_page=1": [{ state: "success" }],
    });
    expect(await result).toMatchObject({ ok: true, value: { ref: "2.2.4" } });
  });

  it("fails when no deployment is currently successful", async () => {
    const { result } = resolve("github-deployment:prod", {
      [DEPLOYMENTS]: [{ id: 1, sha: "a".repeat(40), ref: "2.2.4" }],
      "/deployments/1/statuses?per_page=1": [{ state: "error" }],
    });
    expect(await result).toEqual({
      ok: false,
      error:
        'cannot resolve github-deployment:prod: none of the newest 1 deployments to environment "prod" in acme/shop is currently successful',
    });
  });

  it("fails when the environment has no deployment", async () => {
    const { result } = resolve("github-deployment:prod", { [DEPLOYMENTS]: [] });
    expect(await result).toEqual({
      ok: false,
      error: 'cannot resolve github-deployment:prod: no deployment to environment "prod" in acme/shop',
    });
  });

  it("names the request and a token hint on HTTP 404", async () => {
    const { result } = resolve("github-deployment:prod", {});
    const resolved = await result;
    expect(resolved.ok).toBe(false);
    expect(!resolved.ok && resolved.error).toBe(
      `cannot resolve github-deployment:prod: GET https://github.test/api/v3/repos/acme/shop${DEPLOYMENTS} returned HTTP 404 (check that the token can read the repository, its deployments and its Actions runs)`,
    );
  });

  it("fails on a body of the wrong shape", async () => {
    const { result } = resolve("github-deployment:prod", { [DEPLOYMENTS]: { message: "nope" } });
    const resolved = await result;
    expect(!resolved.ok && resolved.error).toContain("returned an unexpected body");
  });

  it("fails without a token when gh is not available", async () => {
    const { result, github } = resolve(
      "github-deployment:prod",
      {},
      { PATH: "", GITHUB_REPOSITORY: "acme/shop" },
    );
    expect(await result).toEqual({
      ok: false,
      error:
        "cannot resolve github-deployment:prod: no GitHub token: set GH_TOKEN or GITHUB_TOKEN, or sign in with the gh CLI",
    });
    expect(github.calls).toEqual([]);
  });

  it("fails on an empty environment", async () => {
    const { result } = resolve("github-deployment:", {});
    expect(await result).toEqual({
      ok: false,
      error: "cannot resolve github-deployment:: an environment is required after the colon",
    });
  });
});

describe("github-workflow", () => {
  const RUNS = "/actions/workflows/deploy-prod.yml/runs?status=success&per_page=1";

  it("resolves the head SHA of the latest successful workflow_dispatch run", async () => {
    const { result } = resolve("github-workflow:deploy-prod.yml", {
      [RUNS]: {
        workflow_runs: [{ head_sha: "e".repeat(40), head_branch: "2.2.4", event: "workflow_dispatch" }],
      },
    });
    expect(await result).toEqual({
      ok: true,
      value: { ref: "2.2.4", commit: "e".repeat(40), resolver: "github-workflow:deploy-prod.yml" },
    });
  });

  it("labels the run by its SHA when it has no branch", async () => {
    const { result } = resolve("github-workflow:deploy-prod.yml", {
      [RUNS]: { workflow_runs: [{ head_sha: "e".repeat(40), head_branch: null, event: "push" }] },
    });
    expect(await result).toMatchObject({ ok: true, value: { ref: "e".repeat(40) } });
  });

  it("fails when the workflow never succeeded", async () => {
    const { result } = resolve("github-workflow:deploy-prod.yml", { [RUNS]: { workflow_runs: [] } });
    expect(await result).toEqual({
      ok: false,
      error:
        'cannot resolve github-workflow:deploy-prod.yml: no successful run of workflow "deploy-prod.yml" in acme/shop',
    });
  });
});

describe("latest-tag", () => {
  it("picks the newest tag in version order", async () => {
    const { result } = resolve("latest-tag:v*", {});
    expect(await result).toEqual({ ok: true, value: { ref: "v2.0.0", resolver: "latest-tag:v*" } });
  });

  it("orders 1.2.10 after 1.2.9", async () => {
    const { result } = resolve("latest-tag:v1.*", {});
    expect(await result).toMatchObject({ ok: true, value: { ref: "v1.2.10" } });
  });

  it("considers every tag without a glob", async () => {
    const { result } = resolve("latest-tag", {});
    expect(await result).toMatchObject({ ok: true, value: { ref: "v2.0.0" } });
  });

  it("fails when no tag matches", async () => {
    const { result } = resolve("latest-tag:release-*", {});
    const resolved = await result;
    expect(!resolved.ok && resolved.error).toBe(
      `cannot resolve latest-tag:release-*: no tag matches "release-*" in ${repo.dir}; fetch tags (actions/checkout with fetch-depth: 0)`,
    );
  });
});

describe("parseRemoteUrl", () => {
  it.each([
    "git@github.com:acme/shop.git",
    "https://github.com/acme/shop.git",
    "https://github.com/acme/shop",
    "ssh://git@github.com/acme/shop.git",
  ])("reads %s", (url) => {
    expect(parseRemoteUrl(url)).toEqual({ owner: "acme", repo: "shop" });
  });

  it("returns null for a path without owner and repo", () => {
    expect(parseRemoteUrl("shop")).toBeNull();
  });
});
