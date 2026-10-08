import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { main } from "../../src/main.js";
import { createRepo, type TestRepo, writeRepoFile } from "../helpers/git-repo.js";
import { findRealOasdiff, shouldSkipRealOasdiff } from "../helpers/oasdiff.js";
import { createIo } from "../helpers/stub-layer.js";

const oasdiff = findRealOasdiff();
const CLIENT_PATH = "web/api/client.ts";

const spec = (latitude: string) => `openapi: 3.0.3
info:
  title: Vendors (rollback fixture)
  version: "1"
paths:
  /api/service-vendors:
    post:
      operationId: addVendor
      requestBody:
        required: true
        content:
          application/json:
            schema:
              type: object
              required: [name, latitude]
              properties:
                name:
                  type: string
                latitude:
                  ${latitude}
      responses:
        "200":
          description: ok
`;

const client = (latitude: string) => `export const vendorsClient = {
  addVendor(body: AddVendor): Promise<void> {
    return fetch("/api/service-vendors", { method: "POST", body: JSON.stringify(body) }).then(() => undefined);
  },
};

export interface AddVendor {
  name: string;
  ${latitude};
}
`;

let repo: TestRepo;

beforeAll(() => {
  repo = createRepo([
    {
      files: {
        "api/b2b.yaml": spec("type: number"),
        [CLIENT_PATH]: client("latitude: number"),
        "web/ProfileAddPage.tsx": "vendorsClient.addVendor({ name, latitude });\n",
      },
      tag: "2.2.4",
    },
    {
      files: {
        "api/b2b.yaml": spec("type: number\n                  nullable: true"),
        [CLIENT_PATH]: client("latitude: number | null"),
        "web/ProfileAddPage.tsx": "vendorsClient.addVendor({ name, latitude: undefined });\n",
      },
      tag: "2.3.7",
    },
  ]);
  for (const deployedWith of ["revision", undefined]) {
    writeRepoFile(
      repo,
      `${deployedWith ?? "independent"}.json`,
      JSON.stringify({
        layers: {
          openapi: {
            apis: [{ name: "b2b", source: { kind: "file", path: "api/b2b.yaml" } }],
            oasdiff: { path: oasdiff ?? "oasdiff" },
          },
          "client-usage": {
            clients: [
              {
                name: "b2b",
                api: "b2b",
                refs: ["2.2.4"],
                generatedClient: { kind: "typescript", path: CLIENT_PATH },
                sources: ["web/**/*.tsx"],
                ...(deployedWith === undefined ? {} : { deployedWith }),
              },
            ],
          },
        },
      }),
    );
  }
});
afterAll(() => repo.cleanup());

async function runCheck(config: string) {
  const run = createIo(repo.dir);
  const args = ["check", "--base", "2.2.4", "--revision", "2.3.7", "--config", config, "--format", "json"];
  const exitCode = await main([...args, "--fail-on", "rollback-risk"], run.io);
  const report = JSON.parse(run.stdout());
  const openapi = report.layers.find((layer: { layer: string }) => layer.layer === "openapi");
  const clientUsage = report.layers.find((layer: { layer: string }) => layer.layer === "client-usage");
  return { exitCode, openapi, clientUsage };
}

describe.skipIf(shouldSkipRealOasdiff(oasdiff))(
  "client-usage rollback view with real oasdiff (issue #104)",
  () => {
    it("marks a request property the revision web build sends as null as rollback-risk", async () => {
      const { exitCode, openapi, clientUsage } = await runCheck("revision.json");
      expect(clientUsage.status).toBe("ran");
      const nullable = openapi.findings.find(
        (finding: { id: string }) => finding.id === "request-property-became-nullable",
      );
      expect(nullable.class).toBe("rollback-risk");
      expect(nullable.reclassified).toMatchObject({ from: "safe", by: "client-usage" });
      expect(nullable.message).toContain("gets `latitude` null or missing from b2b@2.3.7");
      expect(nullable.evidence).toContainEqual(
        expect.objectContaining({ side: "client", ref: "2.3.7", path: "web/ProfileAddPage.tsx", line: 1 }),
      );
      expect(exitCode).toBe(1);
    });

    it("keeps the widening safe for a client that does not deploy with the server", async () => {
      const { exitCode, openapi } = await runCheck("independent.json");
      const nullable = openapi.findings.find(
        (finding: { id: string }) => finding.id === "request-property-became-nullable",
      );
      expect(nullable.class).toBe("safe");
      expect(exitCode).toBe(0);
    });
  },
);
