import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { formatRefListEntry, refListSchema, resolveRefList } from "../../src/resolve/ref-list.js";
import { resolveWorkflowRuns } from "../../src/resolve/resolve-ref.js";
import { createFakeGitHub, GITHUB_ENV } from "../helpers/fake-github.js";
import { createRepo, type TestRepo } from "../helpers/git-repo.js";

let repo: TestRepo;

beforeAll(() => {
  repo = createRepo([
    { files: { "a.txt": "1" }, tag: "2.0.1" },
    { files: { "a.txt": "2" }, tag: "2.2.4" },
    { files: { "a.txt": "3" }, tag: "2.3.5" },
  ]);
});
afterAll(() => repo.cleanup());

const sha = (char: string) => char.repeat(40);
const run = (headBranch: string | null, headSha: string) => ({
  head_sha: headSha,
  head_branch: headBranch,
  event: "push",
});
const runsPath = (page: number, query = "") =>
  `/actions/workflows/eas-prod.yml/runs?status=success&per_page=100&page=${page}${query}`;

// PETSEO: eas-prod.yml runs on mobile tags only; server tags 2.3.x are interleaved in git but never built.
const PETSEO_RUNS = {
  workflow_runs: [
    run("2.2.4", sha("e")),
    run("2.1.2", sha("d")),
    run("2.1.1", sha("c")),
    run("2.1.1", sha("9")),
    run("2.0.2", sha("b")),
    run("2.0.1", sha("a")),
    run("1.9.0", sha("8")),
    run("main", sha("7")),
  ],
};

function resolveRuns(since: string | undefined, routes: Record<string, unknown>) {
  const github = createFakeGitHub(routes);
  const result = resolveWorkflowRuns(
    { workflow: "eas-prod.yml", since },
    { repoDir: repo.dir, env: GITHUB_ENV, fetch: github.fetch },
  );
  return { github, result };
}

describe("resolveWorkflowRuns", () => {
  it("resolves every successful run since a version, newest run per tag, in version order", async () => {
    const { result } = resolveRuns("2.0.1", { [runsPath(1)]: PETSEO_RUNS });
    expect(await result).toEqual({
      ok: true,
      value: [
        { ref: "2.0.1", commit: sha("a") },
        { ref: "2.0.2", commit: sha("b") },
        { ref: "2.1.1", commit: sha("c") },
        { ref: "2.1.2", commit: sha("d") },
        { ref: "2.2.4", commit: sha("e") },
      ],
    });
  });

  it("keeps runs without a version, last, when there is no since", async () => {
    const { result } = resolveRuns(undefined, {
      [runsPath(1)]: { workflow_runs: [run("main", sha("7")), run(null, sha("6")), run("2.0.1", sha("a"))] },
    });
    expect(await result).toEqual({
      ok: true,
      value: [
        { ref: "2.0.1", commit: sha("a") },
        { ref: sha("6"), commit: sha("6") },
        { ref: "main", commit: sha("7") },
      ],
    });
  });

  it("passes a date since to the API as a created filter", async () => {
    const query = "&created=%3E%3D2026-01-15";
    const { result, github } = resolveRuns("2026-01-15", {
      [runsPath(1, query)]: { workflow_runs: [run("main", sha("7")), run("2.2.4", sha("e"))] },
    });
    expect(await result).toEqual({
      ok: true,
      value: [
        { ref: "2.2.4", commit: sha("e") },
        { ref: "main", commit: sha("7") },
      ],
    });
    expect(github.calls).toEqual([runsPath(1, query)]);
  });

  it("reads further pages while a page is full", async () => {
    const full = { workflow_runs: Array.from({ length: 100 }, (_, index) => run(`3.0.${index}`, sha("f"))) };
    const { result, github } = resolveRuns("3.0.99", {
      [runsPath(1)]: full,
      [runsPath(2)]: { workflow_runs: [run("2.0.0", sha("a"))] },
    });
    expect(await result).toEqual({ ok: true, value: [{ ref: "3.0.99", commit: sha("f") }] });
    expect(github.calls).toEqual([runsPath(1), runsPath(2)]);
  });

  it("fails past ten full pages instead of reading a partial list", async () => {
    const full = { workflow_runs: Array.from({ length: 100 }, () => run("2.0.0", sha("a"))) };
    const routes = Object.fromEntries(Array.from({ length: 10 }, (_, index) => [runsPath(index + 1), full]));
    const { result } = resolveRuns(undefined, routes);
    expect(await result).toEqual({
      ok: false,
      error: 'workflow "eas-prod.yml" has more than 1000 successful runs; set "since" to a date (YYYY-MM-DD)',
    });
  });

  it("fails when no run is at or above since", async () => {
    const { result } = resolveRuns("3.0.0", { [runsPath(1)]: PETSEO_RUNS });
    expect(await result).toEqual({
      ok: false,
      error: 'no successful run of workflow "eas-prod.yml" since 3.0.0 in acme/shop',
    });
  });

  it("fails on a since that is neither a version nor a date", async () => {
    const { result } = resolveRuns("next", { [runsPath(1)]: PETSEO_RUNS });
    expect(await result).toEqual({
      ok: false,
      error: '"since" next holds no version and is not a date (YYYY-MM-DD)',
    });
  });

  it("fails on an HTTP error", async () => {
    const { result } = resolveRuns(undefined, { [runsPath(1)]: 403 });
    const resolved = await result;
    expect(!resolved.ok && resolved.error).toContain("returned HTTP 403");
  });
});

describe("refListSchema", () => {
  it.each([
    [["2.2.4", "github-deployment:prod"]],
    [{ tags: "2.*", since: "2.0.1" }],
    [{ workflowRuns: "eas-prod.yml" }],
    [["latest-tag:web-*", { workflowRuns: "eas-prod.yml", since: "2026-01-01" }, { tags: "m-*" }]],
  ])("accepts %j", (value) => {
    expect(refListSchema.safeParse(value).success).toBe(true);
  });

  it.each([
    [[]],
    [["-x"]],
    [{ workflowRuns: "a.yml", tags: "2.*" }],
    [{ workflowRuns: "" }],
    [{ since: "2" }],
  ])("rejects %j", (value) => {
    expect(refListSchema.safeParse(value).success).toBe(false);
  });
});

describe("formatRefListEntry", () => {
  it("labels resolvers and selectors, not literal refs", () => {
    expect(formatRefListEntry("2.2.4")).toBeUndefined();
    expect(formatRefListEntry("github-deployment:prod")).toBe("github-deployment:prod");
    expect(formatRefListEntry({ tags: "2.*", since: "2.0.1" })).toBe("tags:2.* since 2.0.1");
    expect(formatRefListEntry({ workflowRuns: "eas-prod.yml" })).toBe("workflowRuns:eas-prod.yml");
  });
});

describe("resolveRefList", () => {
  const DEPLOYMENTS = "/deployments?environment=prod&per_page=100";

  it("resolves a mixed list, labels each resolver and keeps a commit once", async () => {
    const github = createFakeGitHub({
      [DEPLOYMENTS]: [{ id: 1, sha: sha("e"), ref: "2.2.4" }],
      "/deployments/1/statuses?per_page=1": [{ state: "success" }],
      [runsPath(1)]: { workflow_runs: [run("2.2.4", sha("e")), run("2.0.1", sha("a"))] },
    });
    const result = await resolveRefList(
      ["2.0.1", "github-deployment:prod", "latest-tag", { workflowRuns: "eas-prod.yml" }],
      { repoDir: repo.dir, env: GITHUB_ENV, fetch: github.fetch },
    );
    expect(result).toEqual({
      ok: true,
      value: [
        { ref: "2.0.1" },
        { ref: "2.2.4", commit: sha("e"), resolver: "github-deployment:prod" },
        { ref: "2.3.5", resolver: "latest-tag" },
        { ref: "2.0.1", commit: sha("a"), resolver: "workflowRuns:eas-prod.yml" },
      ],
    });
  });

  it("drops a repeated literal ref", async () => {
    const result = await resolveRefList(["2.0.1", "2.0.1"], { repoDir: repo.dir, env: GITHUB_ENV });
    expect(result).toEqual({ ok: true, value: [{ ref: "2.0.1" }] });
  });

  it("resolves a tags selector on its own", async () => {
    const result = await resolveRefList(
      { tags: "2.*", since: "2.2.0" },
      { repoDir: repo.dir, env: GITHUB_ENV },
    );
    expect(result).toEqual({
      ok: true,
      value: [
        { ref: "2.2.4", resolver: "tags:2.* since 2.2.0" },
        { ref: "2.3.5", resolver: "tags:2.* since 2.2.0" },
      ],
    });
  });

  it("names the selector that failed", async () => {
    const github = createFakeGitHub({ [runsPath(1)]: { workflow_runs: [] } });
    const result = await resolveRefList(
      { workflowRuns: "eas-prod.yml" },
      { repoDir: repo.dir, env: GITHUB_ENV, fetch: github.fetch },
    );
    expect(result).toEqual({
      ok: false,
      error:
        'cannot resolve workflowRuns:eas-prod.yml: no successful run of workflow "eas-prod.yml" in acme/shop',
    });
  });

  it("fails when no local tag matches", async () => {
    const result = await resolveRefList({ tags: "9.*" }, { repoDir: repo.dir, env: GITHUB_ENV });
    expect(result).toEqual({
      ok: false,
      error: "no local tag matches 9.*; fetch tags (actions/checkout with fetch-depth: 0)",
    });
  });
});
