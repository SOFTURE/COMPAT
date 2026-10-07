import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { main } from "../../src/main.js";
import { createRepo, type TestRepo, writeRepoFile } from "../helpers/git-repo.js";
import { findRealOasdiff, shouldSkipRealOasdiff } from "../helpers/oasdiff.js";
import { createIo } from "../helpers/stub-layer.js";

const fixture = (name: string) =>
  readFileSync(new URL(`../fixtures/openapi/f1-f2/${name}`, import.meta.url), "utf8");
const SERVE_APP = fileURLToPath(new URL("../helpers/serve-app.mjs", import.meta.url));
const oasdiff = findRealOasdiff();

let repo: TestRepo;

beforeAll(() => {
  // No committed spec in the app's eyes: it reads the YAML only at runtime and serves it over HTTP.
  repo = createRepo([
    { files: { "src/spec.yaml": fixture("base.yaml") }, tag: "2.2.4" },
    { files: { "src/spec.yaml": fixture("revision.yaml") }, tag: "2.3.4" },
  ]);
  writeRepoFile(
    repo,
    "serve.json",
    JSON.stringify({
      layers: {
        openapi: {
          apis: [
            {
              name: "b2c",
              source: {
                kind: "serve",
                run: `node "${SERVE_APP}"`,
                url: "http://127.0.0.1:{port}/swagger/v1/swagger.json",
                ready: "http://127.0.0.1:{port}/hc",
                env: { APP_PORT: "{port}", APP_SPEC: "src/spec.yaml", APP_START_DELAY_MS: "200" },
                timeoutSeconds: 30,
              },
            },
          ],
          oasdiff: { path: oasdiff ?? "oasdiff" },
        },
      },
    }),
  );
});
afterAll(() => repo.cleanup());

describe.skipIf(shouldSkipRealOasdiff(oasdiff))("openapi serve source with real oasdiff", () => {
  it("starts the app at both refs in parallel and reports the breaking change", async () => {
    const run = createIo(repo.dir);
    const args = [
      "check",
      "--base",
      "2.2.4",
      "--revision",
      "2.3.4",
      "--config",
      "serve.json",
      "--format",
      "json",
    ];
    expect(await main(args, run.io)).toBe(1);
    const [layer] = JSON.parse(run.stdout()).layers;
    expect(layer.status).toBe("ran");
    const breaking = layer.findings.filter((finding: { class: string }) => finding.class === "breaking");
    expect(breaking).toEqual([
      expect.objectContaining({
        id: "request-property-became-not-nullable",
        subject: "POST /api/pets/{petId}/medications",
        evidence: [
          expect.objectContaining({ side: "base", path: "http://127.0.0.1:{port}/swagger/v1/swagger.json" }),
        ],
      }),
    ]);
  });
});
