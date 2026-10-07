import { tmpdir } from "node:os";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { RefTree } from "../../../src/git/ref-tree.js";
import { clientUsageLayer } from "../../../src/layers/client-usage/client-usage-layer.js";
import { clientUsageConfigSchema } from "../../../src/layers/client-usage/config.js";
import type { LayerResult } from "../../../src/model/finding.js";
import { createFakeGitHub, GITHUB_ENV } from "../../helpers/fake-github.js";
import { createRepo, type TestRepo } from "../../helpers/git-repo.js";
import { createFinding } from "../../helpers/stub-layer.js";

const CLIENT = `export const deletePet = (id: string) => fetch(\`/api/pets/\${id}\`, { method: "DELETE" });\n`;

let repo: TestRepo;

beforeAll(() => {
  repo = createRepo([
    { files: { "app/client.ts": CLIENT, "app/screens/pets.ts": "deletePet(id);\n" }, tag: "app-1" },
    { files: { "app/client.ts": "export const nothing = 1;\n" }, tag: "app-2" },
    {
      files: { "app/client.ts": CLIENT, "app/screens/inbox.ts": "switch (item.type) {}\n" },
      tag: "app-3",
    },
  ]);
});
afterAll(() => repo.cleanup());

const openapi: LayerResult = {
  layer: "openapi",
  status: "ran",
  findings: [
    createFinding("breaking", { layer: "openapi", scope: "b2c", subject: "DELETE /api/pets/{petId}" }),
  ],
  notes: [],
};

function run(
  client: Record<string, unknown>,
  results: LayerResult[] | undefined = [openapi],
  github?: { env: NodeJS.ProcessEnv; fetch: typeof fetch },
) {
  const config = clientUsageConfigSchema.parse({
    clients: [
      {
        name: "mobile",
        api: "b2c",
        refs: ["app-1"],
        generatedClient: { kind: "typescript", path: "app/client.ts" },
        ...client,
      },
    ],
  });
  // The layer reads only client refs; the base and revision trees are never touched.
  const unused = {} as RefTree;
  return clientUsageLayer.run({
    config,
    base: unused,
    revision: unused,
    repoDir: repo.dir,
    tempDir: tmpdir(),
    env: github?.env ?? process.env,
    fetch: github?.fetch,
    log: () => {},
    results,
  });
}

const RUNS = "/actions/workflows/build.yml/runs?status=success&per_page=100&page=1";

describe("client-usage layer", () => {
  it("revises the openapi findings and notes what it read", async () => {
    const output = await run({});
    expect(output).toMatchObject({ layer: "client-usage", status: "ran", findings: [] });
    expect(output.status === "ran" && output.notes).toEqual([
      'client "mobile" (API "b2c"): mobile@app-1; 1 operation(s) read',
      "reclassified 0 openapi finding(s) to safe; 1 keep their class with client evidence",
    ]);
    expect(output.revisions?.map((revision) => revision.finding.message)).toEqual([
      "a breaking change; called by mobile@app-1 (client-usage)",
    ]);
  });

  it("reads the refs a resolver chose and names them in a note", async () => {
    const output = await run({ refs: ["latest-tag:app-*"] });
    expect(output).toMatchObject({ status: "ran" });
    expect(output.status === "ran" && output.notes.slice(0, 2)).toEqual([
      'client "mobile" (API "b2c"): mobile@app-3; 1 operation(s) read',
      'client "mobile": latest-tag:app-* → app-3',
    ]);
  });

  it("reads the head commit of every successful workflow run since a version", async () => {
    const app1 = repo.git("rev-parse", "app-1").trim();
    const app3 = repo.git("rev-parse", "app-3").trim();
    const runs = [app3, app1].map((sha, index) => ({
      head_sha: sha,
      head_branch: `mobile-2.${2 - index * 2}`,
      event: "push",
    }));
    const github = createFakeGitHub({ [RUNS]: { workflow_runs: runs } });
    const output = await run({ refs: { workflowRuns: "build.yml", since: "2.0" } }, [openapi], {
      env: GITHUB_ENV,
      fetch: github.fetch,
    });
    expect(output).toMatchObject({ status: "ran" });
    expect(output.status === "ran" && output.notes.slice(0, 2)).toEqual([
      'client "mobile" (API "b2c"): mobile@mobile-2.0, mobile-2.2; 1/1 operation(s) read',
      'client "mobile": workflowRuns:build.yml since 2.0 → mobile-2.0, mobile-2.2',
    ]);
    expect(output.revisions?.[0]?.finding.evidence).toContainEqual(
      expect.objectContaining({ side: "client", ref: "mobile-2.0", commit: app1 }),
    );
  });

  it("fails with a fetch hint when a resolved commit is not in the clone", async () => {
    const github = createFakeGitHub({
      [RUNS]: { workflow_runs: [{ head_sha: "f".repeat(40), head_branch: "mobile-9", event: "push" }] },
    });
    const output = await run({ refs: { workflowRuns: "build.yml" } }, [openapi], {
      env: GITHUB_ENV,
      fetch: github.fetch,
    });
    expect(output).toMatchObject({
      status: "failed",
      error: `client "mobile": workflowRuns:build.yml resolved to mobile-9 (${"f".repeat(40)}), which is not in the local clone; fetch the client refs (actions/checkout with fetch-depth: 0)`,
    });
  });

  it("fails without an openapi or persisted-enums result", async () => {
    expect(await run({}, [])).toMatchObject({
      status: "failed",
      error:
        "client-usage refines openapi and exposed persisted-enums findings; enable layers.openapi or layers.persisted-enums",
    });
  });

  it("is skipped when the openapi layer was skipped", async () => {
    expect(await run({}, [{ layer: "openapi", status: "skipped", reason: "oasdiff not found" }])).toEqual({
      layer: "client-usage",
      status: "skipped",
      reason: "the openapi layer was skipped (oasdiff not found)",
    });
  });

  it.each([
    [
      { generatedClient: { kind: "typescript", path: "app/missing.ts" } },
      'client "mobile": app-1: generated client app/missing.ts does not exist',
    ],
    [
      { refs: ["app-2"] },
      'client "mobile": app-2: no HTTP operation could be read from app/client.ts; is it a generated TypeScript client?',
    ],
    [{ sources: ["web/**/*.ts"] }, 'client "mobile": app-1: sources web/**/*.ts match no file'],
    [
      { refs: { tags: "web-*" } },
      'client "mobile": no local tag matches web-*; fetch tags (actions/checkout with fetch-depth: 0)',
    ],
  ])("fails and revises nothing for %j", async (client, error) => {
    const output = await run(client);
    expect(output).toMatchObject({ status: "failed", error });
    expect(output.revisions).toBeUndefined();
  });

  it("notes an API with no openapi finding", async () => {
    const output = await run({ api: "admin" });
    expect(output.status === "ran" && output.notes).toContain(
      'client "mobile": the openapi layer has no finding for API "admin"',
    );
  });
});

describe("client-usage layer on exposed enums (issue #15)", () => {
  const exposedFinding = createFinding("needs-action", {
    layer: "persisted-enums",
    scope: "NotificationType",
    id: "enum-member-exposed-added",
    subject: "NotificationType.TermsChange",
    exposure: [{ api: "b2c", fields: ["NotificationDto.type"] }],
  });
  const enums: LayerResult = {
    layer: "persisted-enums",
    status: "ran",
    findings: [createFinding("rollback-risk", { layer: "persisted-enums" }), exposedFinding],
    notes: [],
  };
  const sources = ["app/screens/**/*.ts"];

  it("drops the finding to safe when no live ref branches on the field, without openapi", async () => {
    const output = await run({ sources }, [enums]);
    expect(output.status).toBe("ran");
    expect(output.status === "ran" && output.notes).toEqual([
      'client "mobile" (API "b2c"): mobile@app-1; 1 operation(s) read',
      "reclassified 1 exposed enum finding(s) to safe; 0 keep their class with client evidence",
    ]);
    expect(output.revisions).toEqual([
      {
        layer: "persisted-enums",
        index: 1,
        finding: expect.objectContaining({
          class: "safe",
          reclassified: {
            from: "needs-action",
            by: "client-usage",
            reason: "no live client ref branches on NotificationDto.type: mobile@app-1",
          },
        }),
      },
    ]);
  });

  it("keeps the class and cites the switch of a ref that branches", async () => {
    const output = await run({ sources, refs: ["app-1", "app-3"] }, [enums]);
    const revised = output.revisions?.[0]?.finding;
    expect(revised?.class).toBe("needs-action");
    expect(revised?.message).toBe(
      "a needs-action change; mobile@app-3 branch on NotificationDto.type (client-usage)",
    );
    expect(revised?.evidence.at(-1)).toEqual({
      side: "client",
      ref: "app-3",
      commit: expect.any(String),
      path: "app/screens/inbox.ts",
      line: 1,
    });
  });

  it("keeps the class when the client has no sources", async () => {
    const output = await run({}, [enums]);
    expect(output.status === "ran" && output.notes).toContain(
      'client "mobile": no "sources", so whether it branches on exposed enums cannot be checked',
    );
    const revised = output.revisions?.[0]?.finding;
    expect(revised?.class).toBe("needs-action");
    expect(revised?.message).toBe(
      'a needs-action change; mobile@app-1 cannot be checked without "sources" (client-usage)',
    );
  });

  it("leaves a finding of an API without clients alone", async () => {
    const output = await run({ sources, api: "admin" }, [enums]);
    expect(output.revisions).toEqual([]);
  });

  it("refines openapi and enum findings together", async () => {
    const output = await run({ sources }, [openapi, enums]);
    expect(output.revisions?.map((revision) => [revision.layer, revision.finding.class])).toEqual([
      ["openapi", "breaking"],
      ["persisted-enums", "safe"],
    ]);
  });

  it("still refines enum findings when the openapi layer was skipped", async () => {
    const output = await run({ sources }, [{ layer: "openapi", status: "skipped", reason: "off" }, enums]);
    expect(output.status === "ran" && output.notes).toContain("the openapi layer was skipped (off)");
    expect(output.revisions).toHaveLength(1);
  });

  it("is skipped when there is nothing to refine", async () => {
    const plain: LayerResult = { ...enums, findings: [createFinding("rollback-risk")] };
    expect(await run({ sources }, [plain])).toEqual({
      layer: "client-usage",
      status: "skipped",
      reason: "neither openapi findings nor exposed persisted-enums findings to refine",
    });
  });
});

describe("client-usage config", () => {
  const base = {
    name: "mobile",
    api: "b2c",
    refs: ["1.0.0"],
    generatedClient: { kind: "typescript", path: "a.ts" },
  };

  it.each([
    [{ clients: [] }],
    [{ clients: [base, base] }],
    [{ clients: [{ ...base, refs: [] }] }],
    [{ clients: [{ ...base, refs: ["--upload-pack=x"] }] }],
    [{ clients: [{ ...base, generatedClient: { kind: "dart", path: "a.dart" } }] }],
    [{ clients: [{ ...base, generatedClient: { kind: "typescript", path: "../a.ts" } }] }],
    [{ clients: [{ ...base, unknown: true }] }],
  ])("rejects %j", (config) => {
    expect(clientUsageConfigSchema.safeParse(config).success).toBe(false);
  });

  it("accepts a tag pattern", () => {
    expect(
      clientUsageConfigSchema.safeParse({ clients: [{ ...base, refs: { tags: "2.*", since: "2.0.1" } }] })
        .success,
    ).toBe(true);
  });
});
