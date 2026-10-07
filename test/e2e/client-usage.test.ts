import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { main } from "../../src/main.js";
import { createRepo, type TestRepo, writeRepoFile } from "../helpers/git-repo.js";
import { findRealOasdiff, shouldSkipRealOasdiff } from "../helpers/oasdiff.js";
import { createIo } from "../helpers/stub-layer.js";

const fixture = (name: string) =>
  readFileSync(new URL(`../fixtures/client-usage/${name}`, import.meta.url), "utf8");
const oasdiff = findRealOasdiff();
const CLIENT_PATH = "app/api/client.ts";

type ReportFinding = {
  id: string;
  class: string;
  subject: string;
  message: string;
  evidence: { side: string; ref: string; path: string; line?: number }[];
  reclassified?: { from: string; by: string; reason: string };
};

let repo: TestRepo;

function writeConfig(name: string, client: Record<string, unknown>): void {
  writeRepoFile(
    repo,
    name,
    JSON.stringify({
      layers: {
        openapi: {
          apis: [{ name: "b2c", source: { kind: "file", path: "api/b2c.yaml" } }],
          oasdiff: { path: oasdiff ?? "oasdiff" },
        },
        "client-usage": {
          clients: [
            {
              name: "mobile",
              api: "b2c",
              generatedClient: { kind: "typescript", path: CLIENT_PATH },
              ...client,
            },
          ],
        },
      },
    }),
  );
}

beforeAll(() => {
  repo = createRepo([
    {
      files: {
        "api/b2c.yaml": fixture("base.yaml"),
        [CLIENT_PATH]: fixture("client-0.9.0.ts"),
        "app/screens/pets.ts": "petsClient.createPet(pet);\npetsClient.deletePet(id);\n",
      },
      tag: "app-0.9.0",
    },
    {
      files: {
        [CLIENT_PATH]: fixture("client-1.0.0.ts"),
        "app/screens/pets.ts": "petsClient.createPet(pet);\n",
      },
      tag: "app-1.0.0",
    },
    { files: { "api/b2c.yaml": fixture("revision.yaml") }, tag: "server-2" },
  ]);
  writeConfig("both.json", { refs: ["app-0.9.0", "app-1.0.0"] });
  writeConfig("newest.json", { refs: { tags: "app-*", since: "1.0.0" } });
  writeConfig("sources.json", { refs: { tags: "app-*" }, sources: ["app/screens/**/*.ts"] });
  writeConfig("missing-ref.json", { refs: ["app-0.8.0"] });
});
afterAll(() => repo.cleanup());

async function runCheck(config: string) {
  const run = createIo(repo.dir);
  const args = [
    "check",
    "--base",
    "app-1.0.0",
    "--revision",
    "server-2",
    "--config",
    config,
    "--format",
    "json",
  ];
  const exitCode = await main(args, run.io);
  const report = JSON.parse(run.stdout());
  const openapi = report.layers.find((layer: { layer: string }) => layer.layer === "openapi");
  const clientUsage = report.layers.find((layer: { layer: string }) => layer.layer === "client-usage");
  const find = (subject: string): ReportFinding =>
    openapi.findings.find((finding: ReportFinding) => finding.subject === subject);
  return { exitCode, report, openapi, clientUsage, find };
}

describe.skipIf(shouldSkipRealOasdiff(oasdiff))("client-usage layer with real oasdiff (issue #14)", () => {
  it("keeps a property finding breaking while one live ref may omit it, and names the ref", async () => {
    const { exitCode, clientUsage, find } = await runCheck("both.json");
    expect(exitCode).toBe(1);
    expect(clientUsage.status).toBe("ran");
    const property = find("POST /api/pets");
    expect(property.id).toBe("request-property-became-required");
    expect(property.class).toBe("breaking");
    expect(property.reclassified).toBeUndefined();
    expect(property.message).toContain("mobile@app-0.9.0 may send it without `nickname`");
    expect(property.evidence).toContainEqual({
      side: "client",
      ref: "app-0.9.0",
      commit: expect.any(String),
      path: CLIENT_PATH,
      line: 4,
    });
  });

  it("keeps a removed operation that a live ref still calls breaking, naming the client and ref", async () => {
    const { find } = await runCheck("both.json");
    const removed = find("DELETE /api/pets/{petId}");
    expect(removed.id).toBe("api-path-removed-without-deprecation");
    expect(removed.class).toBe("breaking");
    expect(removed.message).toContain("called by mobile@app-0.9.0 (client-usage)");
    expect(removed.evidence).toContainEqual(
      expect.objectContaining({ side: "client", ref: "app-0.9.0", line: 10 }),
    );
  });

  it("drops a removed operation no live ref calls to safe with evidence", async () => {
    const { find } = await runCheck("both.json");
    const legacy = find("GET /api/legacy/report");
    expect(legacy.class).toBe("safe");
    expect(legacy.reclassified).toEqual({
      from: "breaking",
      by: "client-usage",
      reason: "not called by mobile@app-0.9.0, app-1.0.0",
    });
    expect(
      legacy.evidence.filter((evidence) => evidence.side === "client").map((evidence) => evidence.ref),
    ).toEqual(["app-0.9.0", "app-1.0.0"]);
  });

  it("drops the property finding to safe when every live ref always sends it", async () => {
    const { find, clientUsage } = await runCheck("newest.json");
    const property = find("POST /api/pets");
    expect(property.class).toBe("safe");
    expect(property.reclassified).toEqual({
      from: "breaking",
      by: "client-usage",
      reason: "`nickname` is always sent by mobile@app-1.0.0",
    });
    expect(property.evidence).toContainEqual(
      expect.objectContaining({ side: "client", ref: "app-1.0.0", path: CLIENT_PATH, line: 13 }),
    );
    expect(find("DELETE /api/pets/{petId}").class).toBe("safe");
    expect(clientUsage.notes[0]).toBe('client "mobile" (API "b2c"): mobile@app-1.0.0; 1 operation(s) read');
  });

  it("passes the gate when no live ref is affected and prints the reason in Markdown", async () => {
    const run = createIo(repo.dir);
    const args = ["check", "--base", "app-1.0.0", "--revision", "server-2", "--config", "newest.json"];
    expect(await main(args, run.io)).toBe(0);
    expect(run.stdout()).toContain(
      "reclassified from breaking by client-usage: \\`nickname\\` is always sent by mobile@app-1.0.0",
    );
  });

  it("counts an operation as called only when the client's sources reference its function", async () => {
    const { find } = await runCheck("sources.json");
    expect(find("DELETE /api/pets/{petId}").message).toContain("called by mobile@app-0.9.0 (client-usage)");
    expect(find("GET /api/legacy/report").class).toBe("safe");
  });

  it("fails and refines nothing when a client ref is not in the clone", async () => {
    const { exitCode, clientUsage, find } = await runCheck("missing-ref.json");
    expect(exitCode).toBe(1);
    expect(clientUsage.status).toBe("failed");
    expect(clientUsage.error).toContain('client "mobile"');
    expect(clientUsage.error).toContain("app-0.8.0");
    expect(find("GET /api/legacy/report").class).toBe("breaking");
  });
});
