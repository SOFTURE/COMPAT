import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { main } from "../../src/main.js";
import { createRepo, type TestRepo, writeRepoFile } from "../helpers/git-repo.js";
import { findRealOasdiff, shouldSkipRealOasdiff } from "../helpers/oasdiff.js";
import { createIo } from "../helpers/stub-layer.js";

const fixture = (name: string) =>
  readFileSync(new URL(`../fixtures/openapi/f1-f2/${name}`, import.meta.url), "utf8");
const oasdiff = findRealOasdiff();
const F2 = { id: "request-property-became-not-nullable", operation: "POST /api/pets/{petId}/medications" };

let repo: TestRepo;

beforeAll(() => {
  repo = createRepo([
    { files: { "api/b2c.yaml": fixture("base.yaml") }, tag: "2.2.4" },
    { files: { "api/b2c.yaml": fixture("revision.yaml") }, tag: "2.3.4" },
  ]);
  const api = { name: "b2c", source: { kind: "file", path: "api/b2c.yaml" } };
  writeRepoFile(
    repo,
    "plain.json",
    JSON.stringify({ layers: { openapi: { apis: [api], oasdiff: { path: oasdiff ?? "oasdiff" } } } }),
  );
  writeRepoFile(
    repo,
    "accepted.json",
    JSON.stringify({
      layers: {
        openapi: {
          apis: [
            {
              ...api,
              accept: [{ ...F2, reason: "the old app always sends an array; the handler does ?? []" }],
            },
          ],
          oasdiff: { path: oasdiff ?? "oasdiff" },
        },
      },
    }),
  );
  writeRepoFile(repo, "missing.json", JSON.stringify({ layers: { openapi: { apis: [api] } } }));
});
afterAll(() => repo.cleanup());

const check = (config: string, ...extra: string[]) => [
  "check",
  "--base",
  "2.2.4",
  "--revision",
  "2.3.4",
  "--config",
  config,
  ...extra,
];

describe.skipIf(shouldSkipRealOasdiff(oasdiff))("openapi layer with real oasdiff (research F1, F2)", () => {
  it("reports F2 as breaking and F1 as safe, and fails the gate", async () => {
    const run = createIo(repo.dir);
    expect(await main(check("plain.json", "--format", "json"), run.io)).toBe(1);
    const report = JSON.parse(run.stdout());
    const [layer] = report.layers;
    expect(layer.status).toBe("ran");
    const summary = layer.findings.map((finding: { id: string; class: string; subject: string }) => [
      finding.class,
      finding.id,
      finding.subject,
    ]);
    expect(summary).toEqual(
      expect.arrayContaining([
        ["breaking", F2.id, F2.operation],
        ["safe", "endpoint-added", "GET /api/shop/items"],
        ["safe", "endpoint-added", "GET /api/feature-flags"],
      ]),
    );
    expect(summary).toHaveLength(3);
    const f2 = layer.findings.find((finding: { id: string }) => finding.id === F2.id);
    expect(f2.evidence).toEqual([
      expect.objectContaining({ side: "base", ref: "2.2.4", path: "api/b2c.yaml", line: expect.any(Number) }),
    ]);
  });

  it("passes the gate when F2 is accepted and lists it as accepted", async () => {
    const run = createIo(repo.dir);
    expect(await main(check("accepted.json"), run.io)).toBe(0);
    expect(run.stdout()).toContain("**Gate: PASS**");
    expect(run.stdout()).toContain("## Accepted (1)");
    expect(run.stdout()).toContain("accepted: the old app always sends an array; the handler does ?? []");
  });
});

describe("openapi layer without oasdiff", () => {
  const env = { ...process.env, PATH: "/nonexistent", SOFTURE_COMPAT_OASDIFF: undefined };

  it("is skipped and fails the gate", async () => {
    const run = createIo(repo.dir);
    expect(await main(check("missing.json"), { ...run.io, env })).toBe(1);
    expect(run.stdout()).toContain("| openapi | skipped |");
    expect(run.stdout()).toContain("go install github.com/oasdiff/oasdiff@v1.33.0");
    expect(run.stdout()).toContain("oasdiff not found on PATH");
  });

  it("passes with --allow-incomplete", async () => {
    const run = createIo(repo.dir);
    expect(await main(check("missing.json", "--allow-incomplete"), { ...run.io, env })).toBe(0);
  });
});
