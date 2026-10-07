import { tmpdir } from "node:os";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { RefTree } from "../../../src/git/ref-tree.js";
import { clientUsageLayer } from "../../../src/layers/client-usage/client-usage-layer.js";
import { clientUsageConfigSchema } from "../../../src/layers/client-usage/config.js";
import type { LayerResult } from "../../../src/model/finding.js";
import { createRepo, type TestRepo } from "../../helpers/git-repo.js";
import { createFinding } from "../../helpers/stub-layer.js";

const CLIENT = `export const deletePet = (id: string) => fetch(\`/api/pets/\${id}\`, { method: "DELETE" });\n`;

let repo: TestRepo;

beforeAll(() => {
  repo = createRepo([
    { files: { "app/client.ts": CLIENT, "app/screens/pets.ts": "deletePet(id);\n" }, tag: "app-1" },
    { files: { "app/client.ts": "export const nothing = 1;\n" }, tag: "app-2" },
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

function run(client: Record<string, unknown>, results: LayerResult[] | undefined = [openapi]) {
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
    env: process.env,
    log: () => {},
    results,
  });
}

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

  it("fails without an openapi result", async () => {
    expect(await run({}, [])).toMatchObject({
      status: "failed",
      error: "client-usage refines openapi findings; enable layers.openapi",
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
